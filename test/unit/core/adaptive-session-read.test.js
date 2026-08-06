import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJSONLine } from "../../../src/core/canonical-json.js";
import {
  adaptiveSessionPaths,
  readAdaptiveSession,
  readAdaptiveSessionStatus,
  runAdaptiveSession,
} from "../../../src/core/adaptive-session.js";
import { sha256CanonicalJSON, sha256Hex } from "../../../src/core/hash.js";
import { selectExecutionRoute } from "../../../src/core/route-selector.js";

const hash = (value) => sha256Hex(Buffer.from(value, "utf8"));

function contextPack() {
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
  const policy = {
    max_files: 2,
    max_excerpts: 4,
    max_total_bytes: 512,
    max_file_bytes: 256,
    max_source_file_bytes: 4096,
  };
  return {
    schema_version: { major: 1 },
    source_snapshot_sha256: hash("snapshot"),
    task_sha256: hash("task"),
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
      path: "src/app.js",
      source_sha256: hash("source"),
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
    policy_id: "adaptive-read-fixture",
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
    ],
    ...overrides,
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

function outcome(request, policy, overrides = {}) {
  return {
    child_run_evidence_sha256: hash(request.childRunId),
    source_snapshot_sha256: request.contextPack.source_snapshot_sha256,
    route_selection: selectExecutionRoute({
      policy,
      features: {
        context_bytes: request.contextPack.total_bytes,
        allowed_path_count: 1,
        verifier_kind: "command-verifier",
        risk_tier: "low",
      },
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

async function writePair(paths, value) {
  const line = canonicalJSONLine(value);
  const digest = sha256Hex(Buffer.from(line, "utf8"));
  await writeFile(paths.body, line, { encoding: "utf8" });
  await writeFile(paths.digest, `${digest}\n`, { encoding: "utf8" });
  return digest;
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
}

test("readAdaptiveSessionStatus returns bounded completed status and read details include frozen input", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const policy = executionPolicy();
  const pack = contextPack();
  const completed = await runAdaptiveSession({
    sessionId: "session-completed",
    stateDir,
    policy,
    contextPack: pack,
    runAttempt: async (request) => outcome(request, policy),
  });

  const status = await readAdaptiveSessionStatus(stateDir, "session-completed");
  assert.deepEqual(Object.keys(status), [
    "session_id",
    "session_status",
    "attempt_count",
    "terminal_reason",
    "winner_run_id",
    "session_receipt_sha256",
    "policy_sha256",
    "context_pack_sha256",
  ]);
  assert.deepEqual(status, {
    session_id: "session-completed",
    session_status: "completed",
    attempt_count: 1,
    terminal_reason: "winner",
    winner_run_id: "session-completed-child-1",
    session_receipt_sha256: completed.session_receipt_sha256,
    policy_sha256: sha256CanonicalJSON(policy),
    context_pack_sha256: sha256CanonicalJSON(pack),
  });

  const details = await readAdaptiveSession(stateDir, "session-completed");
  assert.equal(details.input.context_pack.source_snapshot_sha256, pack.source_snapshot_sha256);
  assert.deepEqual(details.session, completed.session);

  const paths = adaptiveSessionPaths(stateDir, "session-completed");
  const firstClaim = JSON.parse(await readFile(
    join(paths.attempts, "claim-0000.jsonl"),
    "utf8",
  ));
  await writePair({
    body: join(paths.attempts, "claim-0001.jsonl"),
    digest: join(paths.attempts, "claim-0001.sha256"),
  }, {
    ...firstClaim,
    attempt_index: 1,
    attempt_id: "session-completed-attempt-2",
    child_run_id: "session-completed-child-2",
    route_reason: "verifier_failure",
    retry_context_sha256: sha256CanonicalJSON(null),
  });
  await assert.rejects(
    readAdaptiveSessionStatus(stateDir, "session-completed"),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    readAdaptiveSession(stateDir, "session-completed"),
    (error) => error.code === "safety_refusal",
  );
});

test("readAdaptiveSessionStatus validates complete checkpoints for an in-progress session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const policy = executionPolicy({
    routes: [
      ...executionPolicy().routes,
      {
        route_id: "transient",
        reason: "transient_infra_retry",
        adapter_id: "fixture",
        model_id: "model-large",
        reasoning_effort: "high",
        timeout_ms: 2000,
      },
    ],
  });
  await assert.rejects(
    runAdaptiveSession({
      sessionId: "session-progress",
      stateDir,
      policy,
      contextPack: contextPack(),
      runAttempt(request) {
        if (request.attemptIndex === 0) {
          return outcome(request, policy, {
            status: "verification_failed",
            verification_status: "failed",
            candidate_changes: [],
          });
        }
        throw new Error("child still running elsewhere");
      },
    }),
    /child still running/u,
  );

  const status = await readAdaptiveSessionStatus(stateDir, "session-progress");
  assert.equal(status.session_status, "in_progress");
  assert.equal(status.attempt_count, 1);
  assert.equal(status.terminal_reason, null);
  assert.equal(status.session_receipt_sha256, null);

  const paths = adaptiveSessionPaths(stateDir, "session-progress");
  const danglingClaimPaths = {
    body: join(paths.attempts, "claim-0001.jsonl"),
    digest: join(paths.attempts, "claim-0001.sha256"),
  };
  const danglingClaim = JSON.parse(await readFile(
    danglingClaimPaths.body,
    "utf8",
  ));
  await rm(danglingClaimPaths.body);
  await rm(danglingClaimPaths.digest);
  await writePair(danglingClaimPaths, {
    ...danglingClaim,
    route_reason: "transient_infra_retry",
  });
  await assert.rejects(
    readAdaptiveSessionStatus(stateDir, "session-progress"),
    (error) => error.code === "safety_refusal",
  );
});

test("readAdaptiveSessionStatus validates a terminal parent failure without resuming", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const policy = executionPolicy({
    routes: executionPolicy().routes.map((route) => ({
      ...route,
      timeout_ms: route.reason === "initial" ? 10 : route.timeout_ms,
    })),
  });
  await assert.rejects(
    runAdaptiveSession({
      sessionId: "session-parent-failed",
      stateDir,
      policy,
      contextPack: contextPack(),
      runAttempt(request) {
        return new Promise((resolveAttempt) => {
          request.signal.addEventListener("abort", () => {
            resolveAttempt(outcome(request, policy));
          });
        });
      },
    }),
    (error) => error.code === "infra_error",
  );

  const status = await readAdaptiveSessionStatus(stateDir, "session-parent-failed");
  assert.equal(status.session_status, "parent_failed");
  assert.equal(status.attempt_count, 0);
  assert.equal(status.terminal_reason, null);
  assert.equal(status.winner_run_id, null);

  const paths = adaptiveSessionPaths(stateDir, "session-parent-failed");
  const failure = JSON.parse(await readFile(paths.failure.body, "utf8"));
  await rm(paths.failure.body);
  await rm(paths.failure.digest);
  await writePair(paths.failure, {
    ...failure,
    child_run_id: "unbound-child",
  });
  await assert.rejects(
    readAdaptiveSessionStatus(stateDir, "session-parent-failed"),
    (error) => error.code === "safety_refusal",
  );
});

test("readAdaptiveSessionStatus reports missing roots and sessions without creating paths", async () => {
  const missingStateDir = join(
    await mkdtemp(join(tmpdir(), "adaptive-read-parent-")),
    "missing-state",
  );
  await assert.rejects(
    readAdaptiveSessionStatus(missingStateDir, "missing-session"),
    (error) => error.code === "not_found",
  );
  await assertMissing(missingStateDir);

  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  await assert.rejects(
    readAdaptiveSessionStatus(stateDir, "missing-session"),
    (error) => error.code === "not_found",
  );
  await assertMissing(join(stateDir, "sessions"));
});

test("readAdaptiveSessionStatus preserves telemetry and route terminal reasons", async () => {
  for (const [sessionId, policy, overrides, terminalReason] of [
    [
      "session-telemetry",
      executionPolicy(),
      {
        status: "verification_failed",
        verification_status: "failed",
        usage: undefined,
      },
      "telemetry_missing",
    ],
    [
      "session-no-route",
      executionPolicy({
        routes: executionPolicy().routes.filter(
          (route) => route.reason === "initial",
        ),
      }),
      {
        status: "verification_failed",
        verification_status: "failed",
      },
      "no_authorized_route",
    ],
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
    const completed = await runAdaptiveSession({
      sessionId,
      stateDir,
      policy,
      contextPack: contextPack(),
      runAttempt: async (request) => outcome(request, policy, overrides),
    });
    assert.equal(completed.session.terminal_reason, terminalReason);
    const status = await readAdaptiveSessionStatus(stateDir, sessionId);
    assert.equal(status.terminal_reason, terminalReason);
    assert.equal(status.winner_run_id, null);
  }
});

test("readAdaptiveSessionStatus fails closed on partial, tampered, and symlinked artifacts", async () => {
  const partialStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const partialPaths = adaptiveSessionPaths(partialStateDir, "partial-session");
  await mkdir(partialPaths.root, { recursive: true });
  await mkdir(partialPaths.attempts);
  await writeFile(partialPaths.input.body, "{}\n");
  await assert.rejects(
    readAdaptiveSessionStatus(partialStateDir, "partial-session"),
    (error) => error.code === "safety_refusal",
  );

  const stateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const policy = executionPolicy();
  const completed = await runAdaptiveSession({
    sessionId: "session-tampered",
    stateDir,
    policy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, policy),
  });
  const paths = adaptiveSessionPaths(stateDir, "session-tampered");
  await rm(paths.final.body);
  await rm(paths.final.digest);
  await writePair(paths.final, {
    ...completed.session,
    session_id: "different-session",
  });
  await assert.rejects(
    readAdaptiveSessionStatus(stateDir, "session-tampered"),
    (error) => error.code === "safety_refusal",
  );

  const symlinkStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const symlinkPolicy = executionPolicy();
  await runAdaptiveSession({
    sessionId: "session-symlink",
    stateDir: symlinkStateDir,
    policy: symlinkPolicy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, symlinkPolicy),
  });
  const symlinkPaths = adaptiveSessionPaths(symlinkStateDir, "session-symlink");
  const outside = join(await mkdtemp(join(tmpdir(), "adaptive-read-outside-")), "input.jsonl");
  await writeFile(outside, await readFile(symlinkPaths.input.body, "utf8"));
  await rm(symlinkPaths.input.body);
  await symlink(outside, symlinkPaths.input.body);
  await assert.rejects(
    readAdaptiveSessionStatus(symlinkStateDir, "session-symlink"),
    (error) => error.code === "safety_refusal",
  );

  const rootStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const rootPolicy = executionPolicy();
  await runAdaptiveSession({
    sessionId: "session-root-symlink",
    stateDir: rootStateDir,
    policy: rootPolicy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, rootPolicy),
  });
  const rootPaths = adaptiveSessionPaths(rootStateDir, "session-root-symlink");
  const movedRoot = `${rootPaths.root}-outside`;
  await rename(rootPaths.root, movedRoot);
  await symlink(movedRoot, rootPaths.root);
  await assert.rejects(
    readAdaptiveSessionStatus(rootStateDir, "session-root-symlink"),
    (error) => error.code === "safety_refusal",
  );
});

test("readAdaptiveSessionStatus fails closed on noncanonical input, claim drift, and attempt gaps", async () => {
  const noncanonicalStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  const policy = executionPolicy();
  await runAdaptiveSession({
    sessionId: "session-noncanonical",
    stateDir: noncanonicalStateDir,
    policy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, policy),
  });
  const noncanonicalPaths = adaptiveSessionPaths(
    noncanonicalStateDir,
    "session-noncanonical",
  );
  const input = JSON.parse(await readFile(noncanonicalPaths.input.body, "utf8"));
  const noncanonical = `${JSON.stringify(input, null, 2)}\n`;
  await writeFile(noncanonicalPaths.input.body, noncanonical);
  await writeFile(
    noncanonicalPaths.input.digest,
    `${sha256Hex(Buffer.from(noncanonical, "utf8"))}\n`,
  );
  await assert.rejects(
    readAdaptiveSessionStatus(noncanonicalStateDir, "session-noncanonical"),
    (error) => error.code === "safety_refusal",
  );

  const claimStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  await runAdaptiveSession({
    sessionId: "session-claim-drift",
    stateDir: claimStateDir,
    policy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, policy),
  });
  const claimPathsForSession = adaptiveSessionPaths(
    claimStateDir,
    "session-claim-drift",
  );
  const claimPair = {
    body: join(claimPathsForSession.attempts, "claim-0000.jsonl"),
    digest: join(claimPathsForSession.attempts, "claim-0000.sha256"),
  };
  const claim = JSON.parse(await readFile(claimPair.body, "utf8"));
  await rm(claimPair.body);
  await rm(claimPair.digest);
  await writePair(claimPair, { ...claim, child_run_id: "other-child" });
  await assert.rejects(
    readAdaptiveSessionStatus(claimStateDir, "session-claim-drift"),
    (error) => error.code === "safety_refusal",
  );

  const missingClaimStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  await runAdaptiveSession({
    sessionId: "session-missing-claim",
    stateDir: missingClaimStateDir,
    policy,
    contextPack: contextPack(),
    runAttempt: async (request) => outcome(request, policy),
  });
  const missingClaimPaths = adaptiveSessionPaths(
    missingClaimStateDir,
    "session-missing-claim",
  );
  await rm(join(missingClaimPaths.attempts, "claim-0000.jsonl"));
  await rm(join(missingClaimPaths.attempts, "claim-0000.sha256"));
  await assert.rejects(
    readAdaptiveSessionStatus(missingClaimStateDir, "session-missing-claim"),
    (error) => error.code === "safety_refusal",
  );

  const gapStateDir = await mkdtemp(join(tmpdir(), "adaptive-read-"));
  await runAdaptiveSession({
    sessionId: "session-gap",
    stateDir: gapStateDir,
    policy,
    contextPack: contextPack(),
    runAttempt: async (request) => request.attemptIndex === 0
      ? outcome(request, policy, {
          status: "verification_failed",
          verification_status: "failed",
        })
      : outcome(request, policy),
  });
  const gapPaths = adaptiveSessionPaths(gapStateDir, "session-gap");
  await rm(join(gapPaths.attempts, "attempt-0000.jsonl"));
  await rm(join(gapPaths.attempts, "attempt-0000.sha256"));
  await assert.rejects(
    readAdaptiveSessionStatus(gapStateDir, "session-gap"),
    (error) => error.code === "safety_refusal",
  );
});
