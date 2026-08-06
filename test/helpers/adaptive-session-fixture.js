import { runAdaptiveSession } from "../../src/core/adaptive-session.js";
import { sha256CanonicalJSON, sha256Hex } from "../../src/core/hash.js";
import { selectExecutionRoute } from "../../src/core/route-selector.js";

function digest(value) {
  return sha256Hex(Buffer.from(value, "utf8"));
}

function contextPack() {
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
    source_snapshot_sha256: digest("adaptive-cli-fixture-snapshot"),
    task_sha256: digest("adaptive-cli-fixture-task"),
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
      source_sha256: digest("adaptive-cli-fixture-source"),
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

function executionPolicy() {
  return {
    schema_version: { major: 1 },
    policy_id: "adaptive-cli-fixture",
    attempt_budget: 1,
    token_budget: 100,
    wall_budget_ms: 1000,
    routes: [{
      route_id: "initial",
      reason: "initial",
      adapter_id: "fixture",
      model_id: "fixture-model",
      reasoning_effort: "low",
      timeout_ms: 500,
    }],
  };
}

function missingTiming() {
  return {
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
}

export async function createTerminalAdaptiveSession(stateDir, sessionId) {
  const policy = executionPolicy();
  const pack = contextPack();
  return runAdaptiveSession({
    stateDir,
    sessionId,
    policy,
    contextPack: pack,
    runAttempt: async (request) => ({
      child_run_evidence_sha256: digest(request.childRunId),
      source_snapshot_sha256: pack.source_snapshot_sha256,
      route_selection: selectExecutionRoute({
        policy,
        features: {
          context_bytes: pack.total_bytes,
          allowed_path_count: 1,
          verifier_kind: "command-verifier",
          risk_tier: "low",
        },
        reason: request.routeReason,
      }),
      status: "safety_refusal",
      verification_status: "not_run",
      failure_code: "fixture_refusal",
      timing: missingTiming(),
      candidate_changes: [],
      verifier_diagnostics: {
        adapter_id: "command-verifier",
        code: "not_run",
        message: "",
      },
    }),
  });
}
