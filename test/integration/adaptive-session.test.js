import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adaptiveSessionPaths,
  createProjectSnapshot,
  executeCliCommand,
  readAdaptiveSession,
  resolveAdaptiveSessionWinner,
  resumeAdaptiveSession,
  runOneAttemptRoutedHarness,
  runAdaptiveSession,
  selectExecutionRoute,
  sha256CanonicalJSON,
  sha256Hex,
} from "../../src/index.js";

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function contextPack() {
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
  const packPolicy = {
    max_files: 2,
    max_excerpts: 4,
    max_total_bytes: 512,
    max_file_bytes: 256,
    max_source_file_bytes: 4096,
  };
  return {
    schema_version: { major: 1 },
    source_snapshot_sha256: digest("snapshot"),
    task_sha256: digest("task"),
    policy_sha256: sha256CanonicalJSON(packPolicy),
    policy: packPolicy,
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
      path: "src/app.js",
      source_sha256: digest("source"),
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

function executionPolicy(overrides = {}) {
  return {
    schema_version: { major: 1 },
    policy_id: "adaptive-fixture",
    attempt_budget: 3,
    token_budget: 1000,
    wall_budget_ms: 10_000,
    routes: [
      {
        route_id: "initial",
        reason: "initial",
        adapter_id: "fixture",
        model_id: "model-small",
        reasoning_effort: "low",
        timeout_ms: 1000,
      },
      {
        route_id: "repair",
        reason: "verifier_failure",
        adapter_id: "fixture",
        model_id: "model-large",
        reasoning_effort: "high",
        timeout_ms: 2000,
      },
      {
        route_id: "transient-retry",
        reason: "transient_infra_retry",
        adapter_id: "fixture",
        model_id: "model-small",
        reasoning_effort: "low",
        timeout_ms: 1000,
      },
    ],
    ...overrides,
  };
}

function features(pack = contextPack()) {
  return {
    context_bytes: pack.total_bytes,
    allowed_path_count: 1,
    verifier_kind: "command-verifier",
    risk_tier: "low",
  };
}

function timing(wallMs = 100) {
  return {
    wall_ms: wallMs,
    executor_ms: 60,
    executor_ms_missing_reason: null,
    verification_ms: 20,
    verification_ms_missing_reason: null,
    orchestration_ms: 20,
    orchestration_ms_missing_reason: null,
    localization_ms: null,
    localization_ms_missing_reason: "not_applicable",
    routing_ms: null,
    routing_ms_missing_reason: "not_applicable",
  };
}

function usage(totalTokens = 100) {
  return {
    input_tokens: totalTokens - 20,
    cached_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

function cost(amount = 0.10) {
  return {
    observation_status: "observed_billed",
    amount,
    currency: "USD",
    pricing_source: "fixture-pricing",
  };
}

function outcome(request, policy, overrides = {}) {
  return {
    child_run_evidence_sha256: digest(request.childRunId),
    source_snapshot_sha256: request.contextPack.source_snapshot_sha256,
    route_selection: selectExecutionRoute({
      policy,
      features: features(request.contextPack),
      reason: request.routeReason,
    }),
    status: "completed",
    verification_status: "passed",
    usage: usage(),
    usage_missing_reason: null,
    timing: timing(),
    candidate_changes: [],
    verifier_diagnostics: {
      adapter_id: "command-verifier",
      code: "verification_failed",
      message: "bounded failure",
    },
    ...overrides,
  };
}

test("first child success creates one winner and a hash-bound session receipt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
  const policy = executionPolicy();
  let calls = 0;
  const completed = await runAdaptiveSession({
    sessionId: "session-success",
    stateDir,
    policy,
    contextPack: contextPack(),
    async runAttempt(request) {
      calls += 1;
      return outcome(request, policy);
    },
  });

  assert.equal(calls, 1);
  assert.equal(completed.session.terminal_reason, "winner");
  assert.equal(completed.session.attempts.length, 1);
  assert.equal(completed.session.attempts[0].winner, true);
  assert.match(completed.session_receipt_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    (await readAdaptiveSession(stateDir, "session-success")).session,
    completed.session,
  );
});

test("verification failure builds bounded context and authorizes one repair", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
  const policy = executionPolicy();
  const observed = [];
  const completed = await runAdaptiveSession({
    sessionId: "session-repair",
    stateDir,
    policy,
    contextPack: contextPack(),
    async runAttempt(request) {
      observed.push(request);
      if (request.attemptIndex === 0) {
        return outcome(request, policy, {
          status: "verification_failed",
          verification_status: "failed",
          candidate_changes: [{ path: "src/app.js", sha256: digest("candidate") }],
          verifier_diagnostics: {
            adapter_id: "command-verifier",
            code: "assertion_failed",
            message: "x".repeat(5000),
          },
        });
      }
      return outcome(request, policy);
    },
  });

  assert.equal(observed.length, 2);
  assert.equal(observed[1].routeReason, "verifier_failure");
  assert.equal(observed[1].remainingTokenBudget, 900);
  assert.equal(observed[1].remainingWallBudgetMs, 9900);
  assert.equal(observed[1].remainingCostBudget, null);
  assert.equal(observed[1].timeoutMs, 2000);
  assert.equal(observed[1].retryContext.verifier_diagnostics.truncated, true);
  assert.ok(Buffer.byteLength(
    observed[1].retryContext.verifier_diagnostics.message,
    "utf8",
  ) <= 4096);
  assert.equal(completed.session.attempts[0].winner, false);
  assert.equal(completed.session.attempts[1].winner, true);
  assert.equal(
    completed.session.attempts[1].retry_context_sha256,
    sha256CanonicalJSON(observed[1].retryContext),
  );
});

test("terminal safety outcomes and credential-like diagnostics never escalate", async () => {
  for (const [sessionId, firstOutcome] of [
    ["session-safety", {
      status: "safety_refusal",
      verification_status: "not_run",
      failure_code: "out_of_allowlist",
    }],
    ["session-secret-diagnostic", {
      status: "verification_failed",
      verification_status: "failed",
      verifier_diagnostics: {
        adapter_id: "command-verifier",
        code: "failed",
        message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      },
    }],
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
    const policy = executionPolicy();
    let calls = 0;
    const completed = await runAdaptiveSession({
      sessionId,
      stateDir,
      policy,
      contextPack: contextPack(),
      async runAttempt(request) {
        calls += 1;
        return outcome(request, policy, firstOutcome);
      },
    });
    assert.equal(calls, 1);
    assert.equal(completed.session.terminal_reason, "terminal_failure");
    assert.equal(completed.session.attempts.length, 1);
    assert.throws(
      () => resolveAdaptiveSessionWinner(completed.session),
      /no unique verified winner/u,
    );
  }
});

test("transient retries require an allowlisted typed failure code", async () => {
  for (const [allowed, expectedAttempts] of [[[], 1], [["network_reset"], 2]]) {
    const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
    const policy = executionPolicy();
    const completed = await runAdaptiveSession({
      sessionId: `session-transient-${expectedAttempts}`,
      stateDir,
      policy,
      contextPack: contextPack(),
      transientInfraRetryCodes: allowed,
      async runAttempt(request) {
        return request.attemptIndex === 0
          ? outcome(request, policy, {
              status: "infra_error",
              verification_status: "not_run",
              failure_code: "network_reset",
            })
          : outcome(request, policy);
      },
    });
    assert.equal(completed.session.attempts.length, expectedAttempts);
  }
});

test("attempt token and wall budgets terminate visibly before another child", async () => {
  for (const [sessionId, policyOverrides, outcomeOverrides, terminalReason] of [
    ["attempt-cap", { attempt_budget: 1 }, {}, "attempt_budget_exhausted"],
    ["token-cap", { token_budget: 100 }, { usage: usage(100) }, "token_budget_exhausted"],
    ["wall-cap", { wall_budget_ms: 100 }, { timing: timing(100) }, "wall_budget_exhausted"],
    [
      "cost-cap",
      { cost_budget: { amount: 0.10, currency: "USD", pricing_source: "fixture-pricing" } },
      { cost: cost(0.10), cost_missing_reason: null },
      "cost_budget_exhausted",
    ],
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
    const policy = executionPolicy(policyOverrides);
    let calls = 0;
    const completed = await runAdaptiveSession({
      sessionId,
      stateDir,
      policy,
      contextPack: contextPack(),
      async runAttempt(request) {
        calls += 1;
        return outcome(request, policy, {
          status: "verification_failed",
          verification_status: "failed",
          ...outcomeOverrides,
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(completed.session.terminal_reason, terminalReason);
  }
});

test("resume continues from the next immutable child and refuses tampered attempts", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
  const policy = executionPolicy();
  const runCalls = [];
  const resumeCalls = [];
  let terminalChildOutcome;
  await assert.rejects(runAdaptiveSession({
    sessionId: "session-resume",
    stateDir,
    policy,
    contextPack: contextPack(),
    async runAttempt(request) {
      runCalls.push(request.attemptIndex);
      if (request.attemptIndex === 0) {
        return outcome(request, policy, {
          status: "verification_failed",
          verification_status: "failed",
        });
      }
      terminalChildOutcome = outcome(request, policy);
      throw new Error("simulated interruption");
    },
  }), /simulated interruption/u);

  const resumePaths = adaptiveSessionPaths(stateDir, "session-resume");
  await writeFile(join(resumePaths.root, "session.lock"), `${JSON.stringify({
    schema_version: { major: 1 },
    pid: 2_147_483_647,
    owner_token: "dead-owner",
  })}\n`);

  const completed = await resumeAdaptiveSession({
    sessionId: "session-resume",
    stateDir,
    policy,
    async resumeAttempt(request) {
      resumeCalls.push(request.attemptIndex);
      assert.equal(request.resumed, true);
      return terminalChildOutcome;
    },
  });
  assert.deepEqual(runCalls, [0, 1]);
  assert.deepEqual(resumeCalls, [1]);
  assert.equal(completed.session.attempts.length, 2);

  const paths = adaptiveSessionPaths(stateDir, "session-resume");
  const attemptPath = join(paths.attempts, "attempt-0000.jsonl");
  await writeFile(attemptPath, `${await readFile(attemptPath, "utf8")} `);
  await assert.rejects(
    readAdaptiveSession(stateDir, "session-resume"),
    /digest|JSON line/u,
  );
});

test("concurrent resume cannot execute the same adaptive child twice", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
  const policy = executionPolicy();
  let release;
  let started;
  const startedPromise = new Promise((resolveStarted) => { started = resolveStarted; });
  const blocker = new Promise((resolveRelease) => { release = resolveRelease; });
  const running = runAdaptiveSession({
    sessionId: "session-concurrent",
    stateDir,
    policy,
    contextPack: contextPack(),
    async runAttempt(request) {
      started();
      await blocker;
      return outcome(request, policy);
    },
  });
  await startedPromise;
  await assert.rejects(
    resumeAdaptiveSession({
      sessionId: "session-concurrent",
      stateDir,
      runAttempt: async (request) => outcome(request, policy),
    }),
    /already active/u,
  );
  release();
  const completed = await running;
  assert.equal(completed.session.attempts.length, 1);
});

test("adaptive sessions refuse a symlinked session artifact root", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-state-"));
  const outside = await mkdtemp(join(tmpdir(), "adaptive-session-outside-"));
  await symlink(outside, join(stateDir, "sessions"));
  await assert.rejects(
    runAdaptiveSession({
      sessionId: "session-symlink",
      stateDir,
      policy: executionPolicy(),
      contextPack: contextPack(),
      runAttempt: async () => {},
    }),
    /must be a real directory/u,
  );
});

test("parent deadline aborts a hung child and persists a terminal failure", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-session-"));
  const policy = executionPolicy({
    routes: executionPolicy().routes.map((route) => ({
      ...route,
      timeout_ms: route.reason === "initial" ? 10 : route.timeout_ms,
    })),
  });
  let aborted = false;
  let cleanupCompleted = false;
  await assert.rejects(
    runAdaptiveSession({
      sessionId: "session-timeout",
      stateDir,
      policy,
      contextPack: contextPack(),
      runAttempt(request) {
        return new Promise((resolveAttempt) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            setTimeout(() => {
              cleanupCompleted = true;
              resolveAttempt(outcome(request, policy));
            }, 5);
          });
        });
      },
    }),
    (error) => error.code === "infra_error" && /parent deadline/u.test(error.message),
  );
  assert.equal(aborted, true);
  assert.equal(cleanupCompleted, true);
  const paths = adaptiveSessionPaths(stateDir, "session-timeout");
  const failure = JSON.parse(await readFile(paths.failure.body, "utf8"));
  assert.equal(failure.code, "timeout");
  let resumed = false;
  await assert.rejects(
    resumeAdaptiveSession({
      sessionId: "session-timeout",
      stateDir,
      resumeAttempt: async () => { resumed = true; },
    }),
    /terminal parent failure/u,
  );
  assert.equal(resumed, false);
});

test("adaptive session composes real atomic children and applies only the winner", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "adaptive-atomic-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "adaptive-atomic-control-"));
  const stateDir = join(projectRoot, ".harness");
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/app.txt"), "source\n");
  const atomicPack = contextPack();
  atomicPack.source_snapshot_sha256 = (await createProjectSnapshot(projectRoot)).sha256;
  const manifestPath = join(controlRoot, "manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: { major: 1 },
    manifest_id: "adaptive-atomic",
    name: "Adaptive atomic fixture",
    policy_id: "adaptive-atomic-policy",
    executor_kinds: ["deterministic"],
    input_schema_ref: "adaptive-atomic-input/v1",
    policy_rules: {},
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: [
        "--eval",
        "const fs=require('node:fs');process.exit(fs.readFileSync('src/app.txt','utf8')==='good\\n'?0:1)",
      ],
      timeout_ms: 10_000,
      max_output_bytes: 1024,
    },
  })}\n`);
  await writeFile(inputPath, `${JSON.stringify({
    changes: [{ path: "src/app.txt" }],
    context_pack: atomicPack,
  })}\n`);
  const policy = executionPolicy({
    routes: executionPolicy().routes.slice(0, 2),
  });
  const adapterRegistry = {
    fixture: {
      executor_kind: "deterministic",
      model_ids: ["model-small", "model-large"],
      reasoning_efforts: ["low", "high"],
      executor_input_validator: (value) => value,
      create_executor(selection) {
        return async ({ workspaceRoot, input, signal }) => {
          assert.equal(typeof signal.addEventListener, "function");
          const bytes = Buffer.from(
            selection.reason === "initial" ? "bad\n" : "good\n",
            "utf8",
          );
          const path = input.input.changes[0].path;
          await writeFile(join(workspaceRoot, path), bytes);
          return {
            schema_version: { major: 1 },
            run_id: input.run_id,
            executor_kind: "deterministic",
            status: "completed",
            changes: [{
              path,
              content_base64: bytes.toString("base64"),
              sha256: sha256Hex(bytes),
            }],
          };
        };
      },
    },
  };

  const completed = await runAdaptiveSession({
    sessionId: "session-atomic",
    stateDir,
    policy,
    contextPack: atomicPack,
    async runAttempt(request) {
      try {
        const child = await runOneAttemptRoutedHarness({
          runId: request.childRunId,
          runSpec: {
            schema_version: { major: 1 },
            project_path: projectRoot,
            state_dir: stateDir,
            skill_manifest_path: manifestPath,
            input_path: inputPath,
            executor_kind: "codex",
          },
          policy,
          riskTier: "low",
          routeReason: request.routeReason,
          adapterRegistry,
          signal: request.signal,
        });
        return {
          child_run_evidence_sha256: child.state.receipt_sha256,
          source_snapshot_sha256: child.evidence.receipt.source_snapshot_sha256,
          route_selection: child.route_selection,
          status: "completed",
          verification_status: "passed",
          usage: usage(),
          usage_missing_reason: null,
          timing: timing(),
        };
      } catch (error) {
        assert.equal(error.code, "verification_failed");
        const artifactRoot = join(
          stateDir,
          "runs",
          request.childRunId,
          "artifacts",
        );
        const failure = JSON.parse(await readFile(join(artifactRoot, "failure.jsonl"), "utf8"));
        const result = JSON.parse(await readFile(join(artifactRoot, "result.jsonl"), "utf8"));
        return {
          child_run_evidence_sha256: sha256CanonicalJSON({ failure, result }),
          source_snapshot_sha256: failure.details?.source_snapshot_sha256 ??
            request.contextPack.source_snapshot_sha256,
          route_selection: result.route_selection,
          status: "verification_failed",
          verification_status: "failed",
          failure_code: error.code,
          usage: usage(),
          usage_missing_reason: null,
          timing: timing(),
          candidate_changes: result.changes.map(({ path, sha256 }) => ({ path, sha256 })),
          verifier_diagnostics: {
            adapter_id: "command-verifier",
            code: error.code,
            message: error.message,
          },
        };
      }
    },
  });

  assert.equal(completed.session.attempts.length, 2);
  assert.equal(completed.session.attempts[0].status, "verification_failed");
  assert.equal(completed.session.attempts[1].winner, true);
  assert.equal(await readFile(join(projectRoot, "src/app.txt"), "utf8"), "source\n");

  const applied = await executeCliCommand({
    command: "apply-session",
    runId: "session-atomic",
    approve: completed.session.attempts[1].child_run_evidence_sha256,
    project: projectRoot,
  });
  assert.equal(applied.run_id, "session-atomic-child-2");
  assert.equal(applied.lifecycle_state, "applied");
  assert.equal(await readFile(join(projectRoot, "src/app.txt"), "utf8"), "good\n");
});
