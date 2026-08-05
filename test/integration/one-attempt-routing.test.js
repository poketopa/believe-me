import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createOneAttemptRoutedExecutor,
  readEvidenceBundle,
  readFrozenRunInputs,
  resumeHarness,
  runOneAttemptRoutedHarness,
  selectExecutionRoute,
  sha256Hex,
} from "../../src/index.js";

const nodeFixture = fileURLToPath(new URL(
  "../fixtures/node-reservation-policy/",
  import.meta.url,
));
const springFixture = fileURLToPath(new URL(
  "../fixtures/roomescape-cancel-booking-penalty/",
  import.meta.url,
));

function routePolicy() {
  return {
    schema_version: { major: 1 },
    policy_id: "fixture-one-attempt",
    attempt_budget: 1,
    token_budget: 10_000,
    wall_budget_ms: 60_000,
    routes: [
      {
        route_id: "node-route",
        reason: "initial",
        adapter_id: "fixture-node",
        model_id: "opaque-node-model",
        reasoning_effort: "low",
        timeout_ms: 10_000,
        match: { verifier_kinds: ["command-verifier"] },
      },
      {
        route_id: "spring-route",
        reason: "initial",
        adapter_id: "fixture-spring",
        model_id: "opaque-spring-model",
        reasoning_effort: "medium",
        timeout_ms: 20_000,
        match: { verifier_kinds: ["spring-verifier"] },
      },
    ],
  };
}

function adapterEntry(modelId, reasoningEffort, observed) {
  return {
    executor_kind: "deterministic",
    model_ids: [modelId],
    reasoning_efforts: [reasoningEffort],
    create_executor(selection) {
      observed.factorySelections.push(selection);
      return async ({ workspaceRoot, input }) => {
        observed.executorCalls += 1;
        const path = input.target_path;
        const candidate = Buffer.from(`${input.source}\n// routed fixture\n`, "utf8");
        await writeFile(join(workspaceRoot, path), candidate);
        return {
          schema_version: { major: 1 },
          run_id: input.run_id,
          executor_kind: "deterministic",
          status: "completed",
          changes: [{
            path,
            content_base64: candidate.toString("base64"),
            sha256: sha256Hex(candidate),
          }],
        };
      };
    },
    executor_input_validator(value) {
      return Object.freeze(structuredClone(value));
    },
  };
}

test("Node and Spring fixtures use one injected route without mutating source", async () => {
  const cases = [
    {
      root: nodeFixture,
      target: "src/reservation-policy.js",
      verifier: "command-verifier",
      route: "node-route",
      adapter: "fixture-node",
    },
    {
      root: springFixture,
      target: "src/main/java/com/roomescape/booking/application/ReservationService.java",
      verifier: "spring-verifier",
      route: "spring-route",
      adapter: "fixture-spring",
    },
  ];

  for (const fixture of cases) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "routed-fixture-"));
    await cp(fixture.root, workspaceRoot, { recursive: true, force: true });
    const original = await readFile(join(fixture.root, fixture.target), "utf8");
    const observed = { executorCalls: 0, factorySelections: [] };
    const selection = selectExecutionRoute({
      policy: routePolicy(),
      features: {
        context_bytes: 100,
        allowed_path_count: 1,
        verifier_kind: fixture.verifier,
        risk_tier: "medium",
      },
    });
    const routed = createOneAttemptRoutedExecutor({
      selection,
      adapterRegistry: {
        "fixture-node": adapterEntry("opaque-node-model", "low", observed),
        "fixture-spring": adapterEntry("opaque-spring-model", "medium", observed),
      },
    });
    const routedResult = await routed.executor({
      workspaceRoot,
      input: {
        run_id: `run-${fixture.route}`,
        target_path: fixture.target,
        source: original,
      },
    });
    await assert.rejects(() => routed.executor({}), /cannot be invoked twice/u);

    assert.equal(observed.executorCalls, 1);
    assert.equal(observed.factorySelections.length, 1);
    assert.equal(selection.route_id, fixture.route);
    assert.equal(selection.adapter_id, fixture.adapter);
    assert.deepEqual(routedResult.route_selection, selection);
    assert.equal(await readFile(join(fixture.root, fixture.target), "utf8"), original);
    assert.notEqual(await readFile(join(workspaceRoot, fixture.target), "utf8"), original);
  }
});

test("actual one-attempt run persists route evidence and stops before apply", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "routed-run-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "routed-run-control-"));
  await mkdir(join(projectRoot, "src"));
  const targetPath = "src/app.txt";
  await writeFile(join(projectRoot, targetPath), "source\n");
  const manifestPath = join(controlRoot, "manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: { major: 1 },
    manifest_id: "routed-fixture",
    name: "Routed fixture",
    policy_id: "routed-fixture-policy",
    executor_kinds: ["deterministic"],
    input_schema_ref: "routed-input/v1",
    policy_rules: {},
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: ["--eval", "process.exit(0)"],
      timeout_ms: 10_000,
      max_output_bytes: 1024,
    },
  })}\n`);
  await writeFile(inputPath, `${JSON.stringify({
    changes: [{
      path: targetPath,
      candidate: "candidate\n",
    }],
  })}\n`);
  const stateDir = join(projectRoot, ".harness");
  let executorCalls = 0;
  const adapterRegistry = {
    "fixture-deterministic": {
      executor_kind: "deterministic",
      model_ids: ["opaque-fixture-model"],
      reasoning_efforts: ["low"],
      executor_input_validator: (value) => value,
      create_executor: () => async ({ workspaceRoot, input }) => {
        executorCalls += 1;
        const change = input.input.changes[0];
        const bytes = Buffer.from(change.candidate, "utf8");
        await writeFile(join(workspaceRoot, change.path), bytes);
        return {
          schema_version: { major: 1 },
          run_id: input.run_id,
          executor_kind: "deterministic",
          status: "completed",
          changes: [{
            path: change.path,
            content_base64: bytes.toString("base64"),
            sha256: sha256Hex(bytes),
          }],
        };
      },
    },
  };
  await assert.rejects(runOneAttemptRoutedHarness({
    runId: "run-routed-evidence",
    runSpec: {
      schema_version: { major: 1 },
      project_path: projectRoot,
      state_dir: stateDir,
      skill_manifest_path: manifestPath,
      input_path: inputPath,
      executor_kind: "codex",
    },
    policy: {
      schema_version: { major: 1 },
      policy_id: "actual-route-policy",
      attempt_budget: 1,
      token_budget: 1000,
      wall_budget_ms: 30_000,
      routes: [
        {
          route_id: "untrusted-spring-route",
          reason: "initial",
          adapter_id: "fixture-spring",
          model_id: "opaque-spring-model",
          reasoning_effort: "medium",
          timeout_ms: 10_000,
          match: { verifier_kinds: ["spring-verifier"] },
        },
        {
          route_id: "actual-route",
          reason: "initial",
          adapter_id: "fixture-deterministic",
          model_id: "opaque-fixture-model",
          reasoning_effort: "low",
          timeout_ms: 10_000,
          match: { verifier_kinds: ["command-verifier"] },
        },
      ],
    },
    riskTier: "low",
    adapterRegistry,
    onCheckpoint({ state }) {
      if (state.lifecycle_state === "executing") {
        throw new Error("simulated interruption before routed execution");
      }
    },
  }), /simulated interruption/u);
  assert.equal(executorCalls, 0);
  await assert.rejects(
    resumeHarness({ stateDir, runId: "run-routed-evidence" }),
    /registry must be an object or Map/u,
  );
  const completed = await resumeHarness({
    stateDir,
    runId: "run-routed-evidence",
    adapterRegistry,
  });

  assert.equal(completed.state.lifecycle_state, "receipted");
  assert.equal(executorCalls, 1);
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), "source\n");
  const frozen = await readFrozenRunInputs(stateDir, "run-routed-evidence");
  const evidence = await readEvidenceBundle(completed.state.artifact_root);
  assert.equal(frozen.runSpec.value.project_path, projectRoot);
  assert.equal(frozen.runSpec.value.state_dir, stateDir);
  assert.equal(frozen.runSpec.value.skill_manifest_path, manifestPath);
  assert.equal(frozen.runSpec.value.input_path, inputPath);
  assert.equal(frozen.runSpec.value.executor_kind, "deterministic");
  assert.equal(completed.route_selection.route_id, "actual-route");
  assert.deepEqual(completed.route_selection.features, {
    context_bytes: 0,
    allowed_path_count: 1,
    verifier_kind: "command-verifier",
    risk_tier: "low",
  });
  assert.deepEqual(frozen.workflowPlan.value.route_selection, completed.route_selection);
  assert.deepEqual(evidence.result.route_selection, completed.route_selection);
  assert.equal(evidence.result.changes[0].path, targetPath);
});

test("routed runs reject caller-supplied route features", async () => {
  await assert.rejects(
    runOneAttemptRoutedHarness({ features: { verifier_kind: "spring-verifier" } }),
    /derived from frozen run inputs/u,
  );
});
