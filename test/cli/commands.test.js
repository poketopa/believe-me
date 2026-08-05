import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCliCommand } from "../../src/cli/commands.js";

const hash = "a".repeat(64);

test("init creates an idempotent project-local state config", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const first = await executeCliCommand({ command: "init", project: projectRoot });
  const second = await executeCliCommand({ command: "init", project: projectRoot });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.state_dir, join(projectRoot, ".harness"));
  const config = JSON.parse(await readFile(first.config_path, "utf8"));
  assert.equal(config.project_path, projectRoot);
  assert.equal(config.state_dir, first.state_dir);
});

test("init refuses a symlinked state directory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const outside = await mkdtemp(join(tmpdir(), "vah-cli-outside-"));
  await symlink(outside, join(projectRoot, ".harness"));

  await assert.rejects(
    () => executeCliCommand({ command: "init", project: projectRoot }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("init refuses a symlinked ancestor in an external state directory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const pathRoot = await mkdtemp(join(tmpdir(), "vah-cli-state-path-"));
  const outside = await mkdtemp(join(tmpdir(), "vah-cli-outside-"));
  const redirect = join(pathRoot, "redirect");
  await symlink(outside, redirect);

  await assert.rejects(
    () => executeCliCommand({
      command: "init",
      project: projectRoot,
      stateDir: join(redirect, "state"),
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  await assert.rejects(
    () => lstat(join(outside, "state")),
    (error) => error.code === "ENOENT",
  );
});

test("run maps CLI fields into RunSpec and returns durable identifiers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  let observed;
  const result = await executeCliCommand({
    command: "run",
    project: projectRoot,
    skill: "policy.json",
    executor: "deterministic",
    input: "input.json",
  }, {
    runIdFactory: () => "run-fixed",
    async runDeterministicHarness(options) {
      observed = options;
      return {
        state: {
          run_id: options.runId,
          lifecycle_state: "receipted",
          receipt_sha256: hash,
          artifact_root: join(projectRoot, ".harness", "runs", options.runId, "artifacts"),
        },
      };
    },
  });

  assert.equal(observed.runId, "run-fixed");
  assert.deepEqual(observed.runSpec, {
    schema_version: { major: 1 },
    project_path: projectRoot,
    state_dir: join(projectRoot, ".harness"),
    skill_manifest_path: "policy.json",
    input_path: "input.json",
    executor_kind: "deterministic",
  });
  assert.equal(result.run_id, "run-fixed");
  assert.equal(result.lifecycle_state, "receipted");
});

test("run wires the Codex adapter through the executor-neutral orchestrator", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const executor = async () => {};
  let observed;
  const result = await executeCliCommand({
      command: "run",
      project: projectRoot,
      skill: "policy.json",
      executor: "codex",
      input: "input.json",
    }, {
      runIdFactory: () => "run-codex",
      createCodexExecutor: () => executor,
      async runHarness(options) {
        observed = options;
        return {
          state: {
            run_id: options.runId,
            lifecycle_state: "receipted",
            receipt_sha256: hash,
            artifact_root: join(projectRoot, ".harness", "runs", options.runId, "artifacts"),
          },
        };
      },
    });

  assert.equal(observed.executor, executor);
  assert.deepEqual(observed.executorInputValidator({
    task: "fix",
    allowed_paths: ["src/app.txt"],
  }), {
    task: "fix",
    allowed_paths: ["src/app.txt"],
  });
  assert.equal(observed.runSpec.executor_kind, "codex");
  assert.equal(result.run_id, "run-codex");
});

test("status and receipt expose verified persisted data", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const state = {
    run_id: "run-1",
    lifecycle_state: "receipted",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    receipt_sha256: hash,
    artifact_root: "/artifacts",
  };
  const options = {
    readRunState: async () => ({ state, sha256: "b".repeat(64) }),
    readEvidenceBundle: async () => ({
      receipt_sha256: hash,
      receipt: {
        run_id: "run-1",
        manifest_sha256: hash,
        workflow_plan_sha256: hash,
        source_snapshot_sha256: hash,
      },
    }),
  };

  const status = await executeCliCommand({
    command: "status",
    runId: "run-1",
    project: projectRoot,
  }, options);
  assert.equal(status.state.lifecycle_state, "receipted");
  assert.equal(status.state_sha256, "b".repeat(64));

  const receipt = await executeCliCommand({
    command: "receipt",
    runId: "run-1",
    project: projectRoot,
  }, options);
  assert.equal(receipt.receipt_sha256, hash);
  assert.equal(receipt.receipt.run_id, "run-1");
});

test("missing status maps filesystem absence to not_found", async () => {
  const missing = new Error("missing");
  missing.code = "ENOENT";
  await assert.rejects(
    () => executeCliCommand({ command: "status", runId: "missing" }, {
      readRunState: async () => { throw missing; },
    }),
    (error) => error.code === "not_found" && error.exitCode === 4,
  );
});

test("status receipt and apply refuse a persisted run-id mismatch", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  let applied = false;
  const options = {
    readRunState: async () => ({
      state: {
        run_id: "another-run",
        lifecycle_state: "receipted",
      },
      sha256: hash,
    }),
    readEvidenceBundle: async () => {
      throw new Error("receipt must not be read");
    },
    applyEvidenceBundle: async () => {
      applied = true;
      throw new Error("apply must not run");
    },
  };

  for (const parsed of [
    { command: "status", runId: "requested-run", project: projectRoot },
    { command: "receipt", runId: "requested-run", project: projectRoot },
    {
      command: "apply",
      runId: "requested-run",
      approve: hash,
      project: projectRoot,
    },
  ]) {
    await assert.rejects(
      () => executeCliCommand(parsed, options),
      (error) =>
        error.code === "safety_refusal" &&
        error.details.requested_run_id === "requested-run" &&
        error.details.persisted_run_id === "another-run",
    );
  }
  assert.equal(applied, false);
});

test("unknown exported commands fail closed without reaching apply", async () => {
  let applied = false;
  await assert.rejects(
    () => executeCliCommand({ command: "bogus", runId: "run-1" }, {
      applyEvidenceBundle: async () => { applied = true; },
    }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  assert.equal(applied, false);
});

test("apply delegates approval and verifier without changing CLI contract", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  let observed;
  const result = await executeCliCommand({
    command: "apply",
    runId: "run-1",
    approve: hash,
    project: projectRoot,
  }, {
    readRunState: async () => ({
      state: { run_id: "run-1", lifecycle_state: "receipted" },
    }),
    verifyAppliedProject: async () => true,
    async applyEvidenceBundle(options) {
      observed = options;
      assert.equal(await options.verifier({ projectRoot }), true);
      return {
        state: { run_id: "run-1", lifecycle_state: "applied" },
        receipt_sha256: hash,
        changed_paths: ["src/app.txt"],
      };
    },
  });

  assert.equal(observed.approvalSha256, hash);
  assert.equal(observed.projectRoot, projectRoot);
  assert.deepEqual(result.changed_paths, ["src/app.txt"]);
});

test("apply-session delegates only the unique verified winning child", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const missingTiming = {
    wall_ms: 0,
    executor_ms: null,
    executor_ms_missing_reason: "adapter_not_instrumented",
    verification_ms: null,
    verification_ms_missing_reason: "adapter_not_instrumented",
    orchestration_ms: null,
    orchestration_ms_missing_reason: "adapter_not_instrumented",
    localization_ms: null,
    localization_ms_missing_reason: "not_applicable",
    routing_ms: null,
    routing_ms_missing_reason: "not_applicable",
  };
  const winner = {
    attempt_index: 0,
    attempt_id: "session-1-attempt-1",
    child_run_id: "session-1-child-1",
    child_run_evidence_sha256: hash,
    route_id: "initial",
    route_reason: "initial",
    adapter_id: "fixture",
    model_id: "model",
    reasoning_effort: "low",
    context_pack_sha256: hash,
    status: "completed",
    verification_status: "passed",
    winner: true,
    usage: null,
    usage_missing_reason: "adapter_not_instrumented",
    timing: missingTiming,
    cost: null,
    cost_missing_reason: "provider_not_reported",
  };
  let appliedRunId;
  const result = await executeCliCommand({
    command: "apply-session",
    runId: "session-1",
    approve: hash,
    project: projectRoot,
  }, {
    readAdaptiveSession: async () => ({
      session: {
        schema_version: { major: 1 },
        session_id: "session-1",
        policy_sha256: hash,
        context_pack_sha256: hash,
        attempts: [winner],
        aggregate_usage: null,
        aggregate_usage_missing_reason: "adapter_not_instrumented",
        aggregate_timing: missingTiming,
        aggregate_cost: null,
        aggregate_cost_missing_reason: "provider_not_reported",
        terminal_reason: "winner",
      },
    }),
    readRunState: async () => ({
      state: {
        run_id: winner.child_run_id,
        lifecycle_state: "receipted",
        receipt_sha256: hash,
      },
    }),
    verifyAppliedProject: async () => true,
    async applyEvidenceBundle(options) {
      appliedRunId = options.runId;
      return {
        state: { run_id: options.runId, lifecycle_state: "applied" },
        receipt_sha256: hash,
        changed_paths: ["src/app.txt"],
      };
    },
  });

  assert.equal(appliedRunId, winner.child_run_id);
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, winner.child_run_id);
});

test("apply resolves verification from the digest-bound frozen manifest", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const manifest = {
    schema_version: { major: 1 },
    manifest_id: "node-policy",
    verifier: { adapter_id: "command-verifier" },
  };
  let readBinding;
  let selectedManifest;
  let verifiedRoot;

  const result = await executeCliCommand({
    command: "apply",
    runId: "run-1",
    approve: hash,
    project: projectRoot,
  }, {
    readRunState: async () => ({
      state: {
        run_id: "run-1",
        lifecycle_state: "receipted",
        manifest_sha256: hash,
      },
    }),
    async readFrozenRunInputs(stateDir, runId) {
      readBinding = { stateDir, runId };
      return { manifest: { value: manifest, sha256: hash } };
    },
    createManifestVerifier(value) {
      selectedManifest = value;
      return async ({ workspaceRoot }) => {
        verifiedRoot = workspaceRoot;
        return { status: "passed" };
      };
    },
    async applyEvidenceBundle(options) {
      assert.equal(await options.verifier({ projectRoot }), true);
      return {
        state: { run_id: "run-1", lifecycle_state: "applied" },
        receipt_sha256: hash,
        changed_paths: ["src/app.txt"],
      };
    },
  });

  assert.deepEqual(readBinding, {
    stateDir: join(projectRoot, ".harness"),
    runId: "run-1",
  });
  assert.equal(selectedManifest, manifest);
  assert.equal(verifiedRoot, projectRoot);
  assert.equal(result.lifecycle_state, "applied");
});

test("apply refuses a frozen manifest not bound by persisted state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  let applied = false;

  await assert.rejects(
    () => executeCliCommand({
      command: "apply",
      runId: "run-1",
      approve: hash,
      project: projectRoot,
    }, {
      readRunState: async () => ({
        state: {
          run_id: "run-1",
          lifecycle_state: "receipted",
          manifest_sha256: hash,
        },
      }),
      readFrozenRunInputs: async () => ({
        manifest: { value: {}, sha256: "b".repeat(64) },
      }),
      applyEvidenceBundle: async () => { applied = true; },
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(applied, false);
});
