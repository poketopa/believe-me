import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCliCommand } from "../../src/cli/commands.js";
import { createProjectSnapshot } from "../../src/core/snapshot.js";
import {
  sha256CanonicalJSON,
  sha256CanonicalJSONLine,
  sha256Hex,
} from "../../src/core/hash.js";

const hash = "a".repeat(64);
const paddedHash = "b".repeat(64);

function candidateChange(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

function reviewState(overrides = {}) {
  return {
    run_id: "run-1",
    lifecycle_state: "receipted",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
    receipt_sha256: hash,
    artifact_root: "/artifacts",
    ...overrides,
  };
}

function reviewEvidence(overrides = {}) {
  const change = candidateChange("src/app.txt", "candidate bytes");
  return {
    receipt_sha256: hash,
    receipt: {
      run_id: "run-1",
      manifest_sha256: hash,
      workflow_plan_sha256: hash,
      source_snapshot_sha256: hash,
      verification_sha256: hash,
      result_sha256: hash,
      approval_method: "receipt_sha256",
      issued_at: "2026-08-05T00:00:00.000Z",
    },
    verification: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      status: "passed",
      stdout_sha256: paddedHash,
      stderr_sha256: paddedHash,
      ...overrides.verification,
    },
    result: {
      schema_version: { major: 1 },
      run_id: "run-1",
      executor_kind: "deterministic",
      status: "completed",
      changes: [change],
      ...overrides.result,
    },
  };
}

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function contextPack(sourceSnapshotSha256 = digest("cli-session-snapshot")) {
  const bytes = Buffer.from("export const fixture = true;\n", "utf8");
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
    task_sha256: digest("cli-session-task"),
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
      path: "src/fixture.js",
      source_sha256: digest("cli-session-source"),
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

function sessionPolicy(adapterId = "codex-cli") {
  return {
    schema_version: { major: 1 },
    policy_id: "cli-session-policy",
    attempt_budget: 2,
    token_budget: 1000,
    wall_budget_ms: 10_000,
    routes: [{
      route_id: "initial",
      reason: "initial",
      adapter_id: adapterId,
      model_id: "gpt-5.5",
      reasoning_effort: "medium",
      timeout_ms: 1000,
    }],
  };
}

function sessionManifest() {
  return {
    schema_version: { major: 1 },
    manifest_id: "cli-session-skill",
    name: "CLI session skill",
    policy_id: "cli-session-policy",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task/v1",
    policy_rules: {},
  };
}

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSessionLaunchInputs(root, overrides = {}) {
  const pack = contextPack(overrides.sourceSnapshotSha256);
  const paths = {
    manifest: join(root, "manifest.json"),
    input: join(root, "input.json"),
    policy: join(root, "policy.json"),
    context: join(root, "context.json"),
    retryCodes: join(root, "retry-codes.json"),
  };
  await writeJson(paths.manifest, overrides.manifest ?? sessionManifest());
  await writeJson(paths.context, overrides.contextPack ?? pack);
  await writeJson(paths.input, overrides.input ?? {
    task: "Change src/fixture.js.",
    allowed_paths: ["src/fixture.js"],
    context_pack: overrides.contextPack ?? pack,
  });
  await writeJson(paths.policy, overrides.policy ?? sessionPolicy());
  await writeJson(paths.retryCodes, overrides.retryCodes ?? ["ECONNRESET"]);
  return paths;
}

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

test("run-session validates and freezes launch authority before adaptive delegation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/fixture.js"), "export const fixture = true;\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const files = await writeSessionLaunchInputs(controlRoot, {
    sourceSnapshotSha256: sourceSnapshot.sha256,
  });
  let observed;
  const result = await executeCliCommand({
    command: "run-session",
    runId: "session-1",
    project: projectRoot,
    skill: files.manifest,
    input: files.input,
    policy: files.policy,
    context: files.context,
    riskTier: "low",
    retryCodes: files.retryCodes,
  }, {
    async runAdaptiveSession(options) {
      observed = options;
      return {
        session_receipt_sha256: paddedHash,
        session: {
          session_id: options.sessionId,
          terminal_reason: "winner",
          attempts: [{
            attempt_index: 0,
            child_run_id: "session-1-child-1",
            child_run_evidence_sha256: hash,
            route_id: "initial",
            status: "completed",
            verification_status: "passed",
            winner: true,
          }],
        },
      };
    },
  });

  assert.equal(observed.sessionId, "session-1");
  assert.equal(observed.stateDir, join(projectRoot, ".harness"));
  assert.equal(observed.launch.session_id, "session-1");
  assert.equal(observed.launch.project_path, projectRoot);
  assert.equal(observed.launch.state_dir, join(projectRoot, ".harness"));
  assert.equal(observed.launch.adapter_id, "codex-cli");
  assert.equal(observed.launch.risk_tier, "low");
  assert.deepEqual(observed.launch.transient_infra_retry_codes, ["ECONNRESET"]);
  assert.deepEqual(observed.policy, observed.launch.policy);
  assert.deepEqual(observed.contextPack, observed.launch.context_pack);
  assert.equal(typeof observed.runAttempt, "function");
  assert.deepEqual(result, {
    session_id: "session-1",
    terminal_reason: "winner",
    attempt_count: 1,
    winner_run_id: "session-1-child-1",
    winner_receipt_sha256: hash,
    session_receipt_sha256: paddedHash,
    state_dir: join(projectRoot, ".harness"),
  });
});

test("run-session child attempts report measured wall time", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/fixture.js"), "export const fixture = true;\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const files = await writeSessionLaunchInputs(controlRoot, {
    sourceSnapshotSha256: sourceSnapshot.sha256,
  });
  const clock = [100, 137];
  let attempt;

  await executeCliCommand({
    command: "run-session",
    runId: "session-timing",
    project: projectRoot,
    skill: files.manifest,
    input: files.input,
    policy: files.policy,
    context: files.context,
    riskTier: "low",
  }, {
    now: () => clock.shift(),
    createAdaptiveCodexRegistry: () => ({}),
    async runOneAttemptRoutedHarness() {
      return {
        state: { receipt_sha256: hash },
        evidence: {
          receipt: { source_snapshot_sha256: sourceSnapshot.sha256 },
          result: {},
        },
        route_selection: { route_id: "initial" },
      };
    },
    async runAdaptiveSession(options) {
      attempt = await options.runAttempt({
        childRunId: "session-timing-child-1",
        routeReason: "initial",
      });
      return {
        session_receipt_sha256: paddedHash,
        session: {
          session_id: "session-timing",
          terminal_reason: "winner",
          attempts: [{
            child_run_id: "session-timing-child-1",
            child_run_evidence_sha256: hash,
            winner: true,
          }],
        },
      };
    },
  });

  assert.equal(attempt.timing.wall_ms, 37);
  assert.equal(attempt.failure_code, undefined);
});

test("run-session rejects non-codex adapters before child execution", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/fixture.js"), "export const fixture = true;\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const files = await writeSessionLaunchInputs(controlRoot, {
    sourceSnapshotSha256: sourceSnapshot.sha256,
    policy: sessionPolicy("other-adapter"),
  });
  let delegated = false;

  await assert.rejects(
    () => executeCliCommand({
      command: "run-session",
      runId: "session-1",
      project: projectRoot,
      skill: files.manifest,
      input: files.input,
      policy: files.policy,
      context: files.context,
      riskTier: "low",
    }, {
      async runAdaptiveSession() {
        delegated = true;
      },
    }),
    (error) => error.code === "infra_error",
  );
  assert.equal(delegated, false);
});

test("run-session rejects retry codes that are duplicated or unsorted", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/fixture.js"), "export const fixture = true;\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const files = await writeSessionLaunchInputs(controlRoot, {
    sourceSnapshotSha256: sourceSnapshot.sha256,
  });

  for (const retryCodes of [
    ["ECONNRESET", "ECONNRESET"],
    ["ETIMEDOUT", "ECONNRESET"],
  ]) {
    await writeJson(files.retryCodes, retryCodes);
    await assert.rejects(
      () => executeCliCommand({
        command: "run-session",
        runId: "session-1",
        project: projectRoot,
        skill: files.manifest,
        input: files.input,
        policy: files.policy,
        context: files.context,
        riskTier: "low",
        retryCodes: files.retryCodes,
      }),
      (error) => error.code === "usage_error" && /unique.*sorted/u.test(error.message),
    );
  }
});

test("run-session rejects an in-source state directory without creating it", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const rejectedStateDir = join(projectRoot, "src", "session-state");
  await mkdir(join(projectRoot, "src"));

  await assert.rejects(
    () => executeCliCommand({
      command: "run-session",
      runId: "session-1",
      project: projectRoot,
      skill: "unused-manifest.json",
      input: "unused-input.json",
      policy: "unused-policy.json",
      context: "unused-context.json",
      riskTier: "low",
      stateDir: rejectedStateDir,
    }),
    (error) => error.code === "safety_refusal" && /under '.harness'/u.test(error.message),
  );
  await assert.rejects(
    () => lstat(rejectedStateDir),
    (error) => error.code === "ENOENT",
  );
});

test("resume-session uses the frozen launch and resumes through routed children", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  const stateDir = join(projectRoot, ".harness");
  const launch = {
    ...(() => {
      const pack = contextPack();
      const manifest = sessionManifest();
      const input = {
        task: "Change src/fixture.js.",
        allowed_paths: ["src/fixture.js"],
        context_pack: pack,
      };
      const policy = sessionPolicy();
      return {
        schema_version: { major: 1 },
        session_id: "session-1",
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
      };
    })(),
  };
  let observed;
  const result = await executeCliCommand({
    command: "resume-session",
    runId: "session-1",
    project: projectRoot,
  }, {
    async readAdaptiveSessionLaunchForResume(observedStateDir, sessionId) {
      assert.equal(observedStateDir, stateDir);
      assert.equal(sessionId, "session-1");
      return { launch, sha256: paddedHash };
    },
    async resumeAdaptiveSession(options) {
      observed = options;
      return {
        session_receipt_sha256: paddedHash,
        session: {
          session_id: "session-1",
          terminal_reason: "winner",
          attempts: [{
            attempt_index: 0,
            child_run_id: "session-1-child-1",
            child_run_evidence_sha256: hash,
            route_id: "initial",
            status: "completed",
            verification_status: "passed",
            winner: true,
          }],
        },
      };
    },
  });

  assert.equal(observed.sessionId, "session-1");
  assert.equal(observed.stateDir, stateDir);
  assert.equal(observed.launch, undefined);
  assert.equal(observed.policy, undefined);
  assert.equal(typeof observed.resumeAttempt, "function");
  assert.equal(result.winner_run_id, "session-1-child-1");
  assert.equal(result.state_dir, stateDir);
});

test("resume-session refuses legacy launch-less sessions before adaptive resume", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-session-project-"));
  let resumed = false;
  await assert.rejects(
    () => executeCliCommand({
      command: "resume-session",
      runId: "legacy-session",
      project: projectRoot,
    }, {
      async readAdaptiveSessionLaunchForResume() {
        const error = new Error("Adaptive session has no launch contract bound for resume.");
        error.code = "safety_refusal";
        error.exitCode = 3;
        throw error;
      },
      async resumeAdaptiveSession() {
        resumed = true;
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.equal(resumed, false);
});

test("status and receipt expose verified persisted data", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const state = {
    run_id: "run-1",
    lifecycle_state: "receipted",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
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

test("status-session delegates to the read-only adaptive status boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  let observed;
  const expected = Object.freeze({
    session_id: "session-1",
    session_status: "in_progress",
    attempt_count: 1,
    terminal_reason: null,
    winner_run_id: null,
    session_receipt_sha256: null,
    policy_sha256: hash,
    context_pack_sha256: paddedHash,
  });
  const status = await executeCliCommand({
    command: "status-session",
    runId: "session-1",
    project: projectRoot,
  }, {
    async readAdaptiveSessionStatus(stateDir, sessionId) {
      observed = { stateDir, sessionId };
      return expected;
    },
    runHarness: async () => { throw new Error("status-session must not run"); },
    applyEvidenceBundle: async () => {
      throw new Error("status-session must not apply");
    },
  });

  assert.deepEqual(observed, {
    stateDir: join(projectRoot, ".harness"),
    sessionId: "session-1",
  });
  assert.equal(status, expected);
});

test("review-session summarizes a terminal session without a winner", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const result = await executeCliCommand({
    command: "review-session",
    runId: "session-1",
    project: projectRoot,
  }, {
    readAdaptiveSession: async () => ({
      session_receipt_sha256: paddedHash,
      input: { context_pack: { source_snapshot_sha256: hash } },
      session: {
        session_id: "session-1",
        terminal_reason: "terminal_failure",
        policy_sha256: hash,
        context_pack_sha256: paddedHash,
        attempts: [{
          attempt_index: 0,
          child_run_id: "session-1-child-1",
          child_run_evidence_sha256: hash,
          route_id: "initial",
          status: "safety_refusal",
          verification_status: "not_run",
          winner: false,
        }],
      },
    }),
    readRunState: async () => {
      throw new Error("a no-winner session must not read a child run");
    },
  });

  assert.deepEqual(result, {
    session_id: "session-1",
    review_status: "adaptive_session_verified",
    terminal_reason: "terminal_failure",
    session_receipt_sha256: paddedHash,
    policy_sha256: hash,
    context_pack_sha256: paddedHash,
    attempts: [{
      attempt_index: 0,
      child_run_id: "session-1-child-1",
      route_id: "initial",
      status: "safety_refusal",
      verification_status: "not_run",
      winner: false,
      child_run_evidence_sha256: hash,
    }],
    winner: null,
  });
});

test("review-session preserves distinct bounded no-winner terminal reasons", async () => {
  for (const terminalReason of ["telemetry_missing", "no_authorized_route"]) {
    const result = await executeCliCommand({
      command: "review-session",
      runId: `session-${terminalReason}`,
    }, {
      readAdaptiveSession: async () => ({
        session_receipt_sha256: hash,
        input: { context_pack: { source_snapshot_sha256: hash } },
        session: {
          session_id: `session-${terminalReason}`,
          terminal_reason: terminalReason,
          policy_sha256: hash,
          context_pack_sha256: hash,
          attempts: [],
        },
      }),
    });
    assert.equal(result.terminal_reason, terminalReason);
    assert.equal(result.winner, null);
  }
});

test("review-session verifies the winning child receipt and frozen snapshot", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const childRunId = "session-1-child-1";
  const state = reviewState({ run_id: childRunId });
  const evidence = reviewEvidence();
  evidence.receipt.run_id = childRunId;
  evidence.result.run_id = childRunId;
  const options = {
    readAdaptiveSession: async () => ({
      session_receipt_sha256: paddedHash,
      input: { context_pack: { source_snapshot_sha256: hash } },
      session: {
        session_id: "session-1",
        terminal_reason: "winner",
        policy_sha256: hash,
        context_pack_sha256: paddedHash,
        attempts: [{
          attempt_index: 0,
          child_run_id: childRunId,
          child_run_evidence_sha256: hash,
          route_id: "initial",
          status: "completed",
          verification_status: "passed",
          winner: true,
        }],
      },
    }),
    readRunState: async () => ({ state, sha256: paddedHash }),
    readEvidenceBundle: async () => evidence,
  };
  const result = await executeCliCommand({
    command: "review-session",
    runId: "session-1",
    project: projectRoot,
  }, options);

  assert.deepEqual(result.winner, {
    child_run_id: childRunId,
    receipt_sha256: hash,
  });
  assert.equal(result.review_status, "adaptive_session_verified");

  evidence.receipt.source_snapshot_sha256 = paddedHash;
  state.source_snapshot_sha256 = paddedHash;
  await assert.rejects(
    () => executeCliCommand({
      command: "review-session",
      runId: "session-1",
      project: projectRoot,
    }, options),
    (error) => error.code === "safety_refusal",
  );
});

test("review exposes only the validated receipt and evidence summary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const change = candidateChange("src/app.txt", "candidate bytes");
  const state = reviewState();
  const evidence = reviewEvidence();

  const review = await executeCliCommand({
    command: "review",
    runId: "run-1",
    project: projectRoot,
  }, {
    readRunState: async () => ({ state, sha256: paddedHash }),
    readEvidenceBundle: async () => evidence,
  });

  assert.deepEqual(review, {
    run_id: "run-1",
    lifecycle_state: "receipted",
    state_sha256: paddedHash,
    review_status: "stored_evidence_verified",
    approval: {
      method: "receipt_sha256",
      receipt_sha256: hash,
    },
    bindings: {
      manifest_sha256: hash,
      workflow_plan_sha256: hash,
      source_snapshot_sha256: hash,
      verification_sha256: hash,
      result_sha256: hash,
    },
    verification: {
      adapter_id: "command-verifier",
      status: "passed",
    },
    changes: [{ path: "src/app.txt", sha256: change.sha256 }],
  });
});

test("export-bundle publishes validated review evidence with a bounded response", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const bytes = Buffer.from("portable bytes\n", "utf8");
  let buildInput;
  let writeInput;
  const exported = await executeCliCommand({
    command: "export-bundle",
    runId: "run-1",
    project: projectRoot,
    output: "review.jsonl",
  }, {
    readRunState: async () => ({ state: reviewState(), sha256: paddedHash }),
    readEvidenceBundle: async () => reviewEvidence(),
    buildPortableEvidenceBundle(input) {
      buildInput = input;
      return { bytes };
    },
    async writePortableEvidenceBundle(path, content, options) {
      writeInput = { path, content, options };
      return {
        output_path: join(projectRoot, "review.jsonl"),
        bundle_bytes: bytes.byteLength,
        bundle_sha256: paddedHash,
      };
    },
    cwd: projectRoot,
  });

  assert.equal(buildInput.state.run_id, "run-1");
  assert.equal(buildInput.stateSha256, paddedHash);
  assert.deepEqual(writeInput, {
    path: "review.jsonl",
    content: bytes,
    options: { cwd: projectRoot },
  });
  assert.deepEqual(exported, {
    run_id: "run-1",
    output_path: join(projectRoot, "review.jsonl"),
    bundle_bytes: bytes.byteLength,
    bundle_sha256: paddedHash,
    receipt_sha256: hash,
  });
});

test("verify-bundle dispatches without project or state resolution", async () => {
  let observed;
  const summary = await executeCliCommand({
    command: "verify-bundle",
    bundle: "review.jsonl",
  }, {
    cwd: "/unrelated",
    async readPortableEvidenceBundle(path, options) {
      observed = { path, options };
      return { verification_status: "portable_evidence_verified" };
    },
    readRunState: async () => {
      throw new Error("verify-bundle must not read state");
    },
    readEvidenceBundle: async () => {
      throw new Error("verify-bundle must not read evidence storage");
    },
  });

  assert.deepEqual(observed, {
    path: "review.jsonl",
    options: { cwd: "/unrelated" },
  });
  assert.deepEqual(summary, {
    verification_status: "portable_evidence_verified",
  });
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
    { command: "review", runId: "requested-run", project: projectRoot },
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

test("review refuses every stored state and receipt binding mismatch", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const evidence = reviewEvidence();
  const mismatches = [
    ["receipt_sha256", reviewState({ receipt_sha256: paddedHash })],
    ["manifest_sha256", reviewState({ manifest_sha256: paddedHash })],
    ["workflow_plan_sha256", reviewState({ workflow_plan_sha256: paddedHash })],
    ["source_snapshot_sha256", reviewState({ source_snapshot_sha256: paddedHash })],
  ];

  for (const [field, state] of mismatches) {
    await assert.rejects(
      () => executeCliCommand({
        command: "review",
        runId: "run-1",
        project: projectRoot,
      }, {
        readRunState: async () => ({ state, sha256: paddedHash }),
        readEvidenceBundle: async () => evidence,
      }),
      (error) => error.code === "safety_refusal",
      field,
    );
  }
});

test("review refuses rejected, non-reviewable, and pre-receipt persisted runs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));

  await assert.rejects(
    () => executeCliCommand({
      command: "review",
      runId: "run-1",
      project: projectRoot,
    }, {
      readRunState: async () => ({
        state: {
          run_id: "run-1",
          lifecycle_state: "rejected",
        },
        sha256: paddedHash,
      }),
      readEvidenceBundle: async () => {
        throw new Error("review must not read rejected evidence");
      },
    }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  for (const lifecycleState of ["draft", "planned", "executing"]) {
    let evidenceRead = false;
    await assert.rejects(
      () => executeCliCommand({
        command: "review",
        runId: "run-2",
        project: projectRoot,
      }, {
        readRunState: async () => ({
          state: {
            run_id: "run-2",
            lifecycle_state: lifecycleState,
            receipt_sha256: hash,
          },
          sha256: paddedHash,
        }),
        readEvidenceBundle: async () => {
          evidenceRead = true;
          throw new Error("review must not read non-reviewable evidence");
        },
      }),
      (error) =>
        error.code === "safety_refusal" &&
        error.details.lifecycle_state === lifecycleState,
    );
    assert.equal(evidenceRead, false);
  }

  await assert.rejects(
    () => executeCliCommand({
      command: "review",
      runId: "run-3",
      project: projectRoot,
    }, {
      readRunState: async () => ({
        state: {
          run_id: "run-3",
          lifecycle_state: "receipted",
        },
        sha256: paddedHash,
      }),
    }),
    (error) => error.code === "not_found" && error.exitCode === 4,
  );
});

test("review admits every receipt-bearing review lifecycle", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const evidence = reviewEvidence();

  for (const lifecycleState of [
    "verified",
    "receipted",
    "approved",
    "applied",
    "rolled_back",
  ]) {
    const review = await executeCliCommand({
      command: "review",
      runId: "run-1",
      project: projectRoot,
    }, {
      readRunState: async () => ({
        state: reviewState({ lifecycle_state: lifecycleState }),
        sha256: paddedHash,
      }),
      readEvidenceBundle: async () => evidence,
    });
    assert.equal(review.lifecycle_state, lifecycleState);
    assert.equal(review.review_status, "stored_evidence_verified");
  }
});

test("review refuses malformed verification or mismatched result evidence", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const baseState = reviewState();

  await assert.rejects(
    () => executeCliCommand({
      command: "review",
      runId: "run-1",
      project: projectRoot,
    }, {
      readRunState: async () => ({ state: baseState, sha256: paddedHash }),
      readEvidenceBundle: async () => reviewEvidence({
        verification: { status: "failed" },
      }),
    }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  await assert.rejects(
    () => executeCliCommand({
      command: "review",
      runId: "run-1",
      project: projectRoot,
    }, {
      readRunState: async () => ({ state: baseState, sha256: paddedHash }),
      readEvidenceBundle: async () => reviewEvidence({
        result: { run_id: "other-run" },
      }),
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
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
  let readBoundaryBinding;
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
    async readBoundHermeticBoundary(stateDir, runId, expectedSha256) {
      readBoundaryBinding = { stateDir, runId, expectedSha256 };
      return null;
    },
    createManifestVerifier(value, verifierOptions) {
      selectedManifest = value;
      assert.equal(verifierOptions, undefined);
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
  assert.deepEqual(readBoundaryBinding, {
    stateDir: join(projectRoot, ".harness"),
    runId: "run-1",
    expectedSha256: undefined,
  });
  assert.equal(selectedManifest, manifest);
  assert.equal(verifiedRoot, projectRoot);
  assert.equal(result.lifecycle_state, "applied");
});

test("apply composes verification from the frozen hermetic boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const boundarySha256 = "c".repeat(64);
  const boundary = Object.freeze({ mode: "hermetic" });
  let selectedOptions;

  await executeCliCommand({
    command: "apply",
    runId: "run-hermetic",
    approve: hash,
    project: projectRoot,
  }, {
    readRunState: async () => ({
      state: {
        run_id: "run-hermetic",
        lifecycle_state: "receipted",
        manifest_sha256: hash,
        hermetic_boundary_sha256: boundarySha256,
      },
    }),
    readFrozenRunInputs: async () => ({
      manifest: { value: { verifier: {} }, sha256: hash },
    }),
    async readBoundHermeticBoundary(stateDir, runId, expectedSha256) {
      assert.equal(stateDir, join(projectRoot, ".harness"));
      assert.equal(runId, "run-hermetic");
      assert.equal(expectedSha256, boundarySha256);
      return { boundary, sha256: boundarySha256 };
    },
    createManifestVerifier(_manifest, options) {
      selectedOptions = options;
      return async () => ({ status: "passed" });
    },
    async applyEvidenceBundle(options) {
      assert.equal(await options.verifier({ projectRoot }), true);
      return {
        state: { run_id: "run-hermetic", lifecycle_state: "applied" },
        receipt_sha256: hash,
        changed_paths: [],
      };
    },
  });

  assert.deepEqual(selectedOptions, { hermeticBoundary: boundary });
});

test("hermetic apply refuses an injected verifier after boundary validation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-project-"));
  const boundarySha256 = "c".repeat(64);
  let boundaryReads = 0;
  let applied = false;

  await assert.rejects(
    executeCliCommand({
      command: "apply",
      runId: "run-hermetic",
      approve: hash,
      project: projectRoot,
    }, {
      readRunState: async () => ({
        state: {
          run_id: "run-hermetic",
          lifecycle_state: "receipted",
          hermetic_boundary_sha256: boundarySha256,
        },
      }),
      async readBoundHermeticBoundary(_stateDir, _runId, expectedSha256) {
        boundaryReads += 1;
        assert.equal(expectedSha256, boundarySha256);
        return { boundary: { mode: "hermetic" }, sha256: boundarySha256 };
      },
      verifyAppliedProject: async () => true,
      applyEvidenceBundle: async () => { applied = true; },
    }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );

  assert.equal(boundaryReads, 1);
  assert.equal(applied, false);
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
