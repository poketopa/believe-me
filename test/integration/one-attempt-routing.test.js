import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { executeCliCommand } from "../../src/cli/commands.js";
import {
  createProjectSnapshot,
  createOneAttemptRoutedExecutor,
  readEvidenceBundle,
  readFrozenRunInputs,
  resumeDeterministicHarness,
  resumeHarness,
  runOneAttemptRoutedHarness,
  selectExecutionRoute,
  sha256CanonicalJSON,
  sha256CanonicalJSONLine,
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

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function contextPack(sourceSnapshotSha256) {
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
  const policy = {
    max_files: 1,
    max_excerpts: 1,
    max_total_bytes: 512,
    max_file_bytes: 512,
    max_source_file_bytes: 4096,
  };
  return {
    schema_version: { major: 1 },
    source_snapshot_sha256: sourceSnapshotSha256,
    task_sha256: digest("routed-launch-task"),
    policy_sha256: sha256CanonicalJSON(policy),
    policy,
    selection_status: "matched",
    fallback_reason: null,
    truncated: false,
    truncation_reasons: [],
    omission_counts: {
      binary: 0,
      empty: 0,
      excluded_path: 0,
      oversized: 0,
      secret_content: 0,
    },
    total_files: 1,
    total_excerpts: 1,
    total_bytes: bytes.byteLength,
    entries: [{
      path: "src/app.txt",
      source_sha256: digest("routed-launch-source"),
      reasons: ["text_match"],
      excerpts: [{
        start_byte: 0,
        end_byte: bytes.byteLength,
        content_base64: bytes.toString("base64"),
        sha256: sha256Hex(bytes),
        reasons: ["text_match"],
      }],
    }],
  };
}

function codexManifest() {
  return {
    schema_version: { major: 1 },
    manifest_id: "routed-launch",
    name: "Routed launch fixture",
    policy_id: "routed-launch-policy",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task/v1",
    policy_rules: {},
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: ["--eval", "process.exit(0)"],
      timeout_ms: 10_000,
      max_output_bytes: 1024,
    },
  };
}

function codexPolicy() {
  return {
    schema_version: { major: 1 },
    policy_id: "routed-launch-policy",
    attempt_budget: 1,
    token_budget: 1000,
    wall_budget_ms: 30_000,
    routes: [{
      route_id: "codex-route",
      reason: "initial",
      adapter_id: "codex-cli",
      model_id: "gpt-5.5",
      reasoning_effort: "medium",
      timeout_ms: 10_000,
    }],
  };
}

function adaptiveLaunch({
  sessionId,
  projectRoot,
  stateDir,
  sourceSnapshotSha256,
  overrides = {},
}) {
  const pack = contextPack(sourceSnapshotSha256);
  const manifest = codexManifest();
  const input = {
    task: "Change src/app.txt.",
    allowed_paths: ["src/app.txt"],
    context_pack: pack,
  };
  const policy = codexPolicy();
  return {
    schema_version: { major: 1 },
    session_id: sessionId,
    project_path: projectRoot,
    state_dir: stateDir,
    skill_manifest: manifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(manifest),
    task_input: input,
    task_input_sha256: sha256CanonicalJSON(input),
    policy,
    policy_sha256: sha256CanonicalJSON(policy),
    context_pack: pack,
    context_pack_sha256: sha256CanonicalJSON(pack),
    risk_tier: "low",
    transient_infra_retry_codes: [],
    adapter_id: "codex-cli",
    ...overrides,
  };
}

test("CLI run and idempotent resume compose the real adaptive and routed engines", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "adaptive-cli-run-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "adaptive-cli-run-control-"));
  const stateDir = join(projectRoot, ".harness");
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/app.txt"), "source\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const launch = adaptiveLaunch({
    sessionId: "session-cli-real",
    projectRoot,
    stateDir,
    sourceSnapshotSha256: sourceSnapshot.sha256,
  });
  const manifestPath = join(controlRoot, "manifest.json");
  const inputPath = join(controlRoot, "input.json");
  const policyPath = join(controlRoot, "policy.json");
  const contextPath = join(controlRoot, "context.json");
  await writeFile(manifestPath, `${JSON.stringify(launch.skill_manifest)}\n`);
  await writeFile(inputPath, `${JSON.stringify(launch.task_input)}\n`);
  await writeFile(policyPath, `${JSON.stringify(launch.policy)}\n`);
  await writeFile(contextPath, `${JSON.stringify(launch.context_pack)}\n`);
  let executorCalls = 0;
  const createAdaptiveCodexRegistry = () => ({
    "codex-cli": {
      executor_kind: "codex",
      model_ids: ["gpt-5.5"],
      reasoning_efforts: ["medium"],
      executor_input_validator: (value) => value,
      create_executor: () => async ({ workspaceRoot, input }) => {
        executorCalls += 1;
        const bytes = Buffer.from("candidate\n", "utf8");
        await writeFile(join(workspaceRoot, "src/app.txt"), bytes);
        return {
          schema_version: { major: 1 },
          run_id: input.run_id,
          executor_kind: "codex",
          status: "completed",
          changes: [{
            path: "src/app.txt",
            content_base64: bytes.toString("base64"),
            sha256: sha256Hex(bytes),
          }],
        };
      },
    },
  });

  const completed = await executeCliCommand({
    command: "run-session",
    runId: "session-cli-real",
    project: projectRoot,
    stateDir,
    skill: manifestPath,
    input: inputPath,
    policy: policyPath,
    context: contextPath,
    riskTier: "low",
  }, { createAdaptiveCodexRegistry });
  const reviewed = await executeCliCommand({
    command: "review-session",
    runId: "session-cli-real",
    project: projectRoot,
    stateDir,
  });
  const resumed = await executeCliCommand({
    command: "resume-session",
    runId: "session-cli-real",
    project: projectRoot,
    stateDir,
  }, { createAdaptiveCodexRegistry });

  assert.equal(executorCalls, 1);
  assert.equal(completed.terminal_reason, "winner");
  assert.equal(completed.winner_run_id, "session-cli-real-child-1");
  assert.equal(reviewed.review_status, "adaptive_session_verified");
  assert.equal(reviewed.winner.child_run_id, completed.winner_run_id);
  assert.deepEqual(resumed, completed);
  assert.equal(await readFile(join(projectRoot, "src/app.txt"), "utf8"), "source\n");
});

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
    resumeDeterministicHarness({ stateDir, runId: "run-routed-evidence" }),
    /must resume through resumeHarness/u,
  );
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

test("routed harness binds child records to the adaptive launch", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "routed-launch-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "routed-launch-control-"));
  const stateDir = join(projectRoot, ".harness");
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/app.txt"), "source\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const launch = adaptiveLaunch({
    sessionId: "session-routed-launch",
    projectRoot,
    stateDir,
    sourceSnapshotSha256: sourceSnapshot.sha256,
  });
  const manifestPath = join(controlRoot, "manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeFile(manifestPath, `${JSON.stringify(launch.skill_manifest, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(launch.task_input, null, 2)}\n`);
  let executorCalls = 0;
  const completed = await runOneAttemptRoutedHarness({
    runId: "session-routed-launch-child-1",
    runSpec: {
      schema_version: { major: 1 },
      project_path: projectRoot,
      state_dir: stateDir,
      skill_manifest_path: manifestPath,
      input_path: inputPath,
      executor_kind: "codex",
    },
    policy: launch.policy,
    riskTier: launch.risk_tier,
    routeReason: "initial",
    adaptiveLaunch: launch,
    adapterRegistry: {
      "codex-cli": {
        executor_kind: "codex",
        model_ids: ["gpt-5.5"],
        reasoning_efforts: ["medium"],
        executor_input_validator: (value) => value,
        create_executor: () => async ({ workspaceRoot, input }) => {
          executorCalls += 1;
          assert.equal(input.input.task, launch.task_input.task);
          const bytes = Buffer.from("candidate\n", "utf8");
          await writeFile(join(workspaceRoot, "src/app.txt"), bytes);
          return {
            schema_version: { major: 1 },
            run_id: input.run_id,
            executor_kind: "codex",
            status: "completed",
            changes: [{
              path: "src/app.txt",
              content_base64: bytes.toString("base64"),
              sha256: sha256Hex(bytes),
            }],
          };
        },
      },
    },
  });

  assert.equal(executorCalls, 1);
  assert.equal(completed.route_selection.policy_sha256, launch.policy_sha256);
  assert.equal(completed.route_selection.features.context_bytes, launch.context_pack.total_bytes);
  assert.equal(completed.state.source_snapshot_sha256, launch.context_pack.source_snapshot_sha256);
  const frozen = await readFrozenRunInputs(stateDir, "session-routed-launch-child-1");
  assert.equal(frozen.manifest.sha256, launch.skill_manifest_sha256);
  assert.equal(frozen.runSpec.value.project_path, launch.project_path);
  assert.equal(frozen.runSpec.value.state_dir, launch.state_dir);
});

test("routed harness rejects adaptive launch drift before child execution", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "routed-launch-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "routed-launch-control-"));
  const stateDir = join(projectRoot, ".harness");
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/app.txt"), "source\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const launch = adaptiveLaunch({
    sessionId: "session-routed-drift",
    projectRoot,
    stateDir,
    sourceSnapshotSha256: sourceSnapshot.sha256,
    overrides: { project_path: join(projectRoot, "other") },
  });
  const manifestPath = join(controlRoot, "manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeFile(manifestPath, `${JSON.stringify(codexManifest(), null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(launch.task_input, null, 2)}\n`);
  let executorCalls = 0;

  await assert.rejects(() => runOneAttemptRoutedHarness({
      runId: "session-routed-drift-child-1",
      runSpec: {
        schema_version: { major: 1 },
        project_path: projectRoot,
        state_dir: stateDir,
        skill_manifest_path: manifestPath,
        input_path: inputPath,
        executor_kind: "codex",
      },
      policy: codexPolicy(),
      riskTier: "low",
      routeReason: "initial",
      adaptiveLaunch: launch,
      adapterRegistry: {
        "codex-cli": {
          executor_kind: "codex",
          model_ids: ["gpt-5.5"],
          reasoning_efforts: ["medium"],
          executor_input_validator: (value) => value,
          create_executor: () => async () => {
            executorCalls += 1;
            throw new Error("drifted launch must fail before child execution");
          },
        },
      },
    }));
  assert.equal(executorCalls, 0);
});

test("routed runs reject caller-supplied route features", async () => {
  await assert.rejects(
    runOneAttemptRoutedHarness({ features: { verifier_kind: "spring-verifier" } }),
    /derived from frozen run inputs/u,
  );
});
