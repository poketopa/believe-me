import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_SESSION_LAUNCH_REQUIRED_FIELDS,
  assertAdaptiveInputMatchesLaunch,
  assertChildExecutorInputMatchesLaunch,
  assertChildManifestMatchesLaunch,
  assertRouteSelectionMatchesLaunch,
  validateAdaptiveSessionLaunch,
} from "../../../src/contracts/adaptive-session-launch.js";
import { sha256CanonicalJSON, sha256CanonicalJSONLine, sha256Hex } from "../../../src/core/hash.js";

const hash = (value) => "a".repeat(63) + value;
const project_path = "/tmp/believe-me-project";
const state_dir = "/tmp/believe-me-state";

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function contextPack() {
  const policy = {
    max_files: 2,
    max_excerpts: 4,
    max_total_bytes: 512,
    max_file_bytes: 256,
    max_source_file_bytes: 4096,
  };
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
  return {
    schema_version: { major: 1 },
    source_snapshot_sha256: hash("1"),
    task_sha256: hash("2"),
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
      source_sha256: hash("3"),
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

function policy(overrides = {}) {
  return {
    schema_version: { major: 1 },
    policy_id: "launch-policy",
    attempt_budget: 2,
    token_budget: 1000,
    wall_budget_ms: 60_000,
    routes: [{
      route_id: "codex-initial",
      reason: "initial",
      adapter_id: "codex-cli",
      model_id: "gpt-5.5",
      reasoning_effort: "medium",
      timeout_ms: 30_000,
    }],
    ...overrides,
  };
}

function skillManifest() {
  return {
    schema_version: { major: 1 },
    manifest_id: "launch-skill",
    name: "Launch skill",
    policy_id: "launch-policy",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task/v1",
    policy_rules: {},
  };
}

function codexTaskInput(pack = contextPack()) {
  return {
    task: "Change src/app.js.",
    allowed_paths: ["src/app.js"],
    context_pack: pack,
  };
}

function launch(overrides = {}) {
  const pack = contextPack();
  const manifest = skillManifest();
  const input = codexTaskInput(pack);
  const executionPolicy = policy();
  return {
    schema_version: { major: 1 },
    session_id: "session-launch",
    project_path,
    state_dir,
    skill_manifest: manifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(manifest),
    task_input: input,
    task_input_sha256: sha256CanonicalJSON(input),
    policy: executionPolicy,
    policy_sha256: sha256CanonicalJSON(executionPolicy),
    context_pack: pack,
    context_pack_sha256: sha256CanonicalJSON(pack),
    risk_tier: "low",
    transient_infra_retry_codes: ["ECONNRESET", "ETIMEDOUT"],
    adapter_id: "codex-cli",
    ...overrides,
  };
}

test("adaptive session launch field table is explicit", () => {
  assert.deepEqual(ADAPTIVE_SESSION_LAUNCH_REQUIRED_FIELDS, [
    "schema_version",
    "session_id",
    "project_path",
    "state_dir",
    "skill_manifest",
    "skill_manifest_sha256",
    "task_input",
    "task_input_sha256",
    "policy",
    "policy_sha256",
    "context_pack",
    "context_pack_sha256",
    "risk_tier",
    "transient_infra_retry_codes",
    "adapter_id",
  ]);
});

test("valid launch freezes authority fields with sorted unique retry codes", () => {
  const validated = validateAdaptiveSessionLaunch(launch());

  assert.equal(validated.adapter_id, "codex-cli");
  assert.deepEqual(validated.transient_infra_retry_codes, [
    "ECONNRESET",
    "ETIMEDOUT",
  ]);
  assertFrozenTree(validated);
});

test("launch rejects duplicate or unsorted retry codes", () => {
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({
      transient_infra_retry_codes: ["ECONNRESET", "ECONNRESET"],
    })),
    /unique and code-unit sorted/u,
  );
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({
      transient_infra_retry_codes: ["ETIMEDOUT", "ECONNRESET"],
    })),
    /unique and code-unit sorted/u,
  );
});

test("launch digest is stable across JSON key order", () => {
  const value = validateAdaptiveSessionLaunch(launch());
  const reordered = validateAdaptiveSessionLaunch({
    adapter_id: "codex-cli",
    transient_infra_retry_codes: ["ECONNRESET", "ETIMEDOUT"],
    risk_tier: "low",
    context_pack_sha256: value.context_pack_sha256,
    context_pack: value.context_pack,
    policy_sha256: value.policy_sha256,
    policy: value.policy,
    task_input_sha256: value.task_input_sha256,
    task_input: value.task_input,
    skill_manifest_sha256: value.skill_manifest_sha256,
    skill_manifest: value.skill_manifest,
    state_dir,
    project_path,
    session_id: "session-launch",
    schema_version: { major: 1 },
  });

  assert.equal(sha256CanonicalJSON(reordered), sha256CanonicalJSON(value));
});

test("launch rejects unsupported schema adapter and extra fields", () => {
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({ schema_version: { major: 2 } })),
    /schema|major|unsupported/u,
  );
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({ adapter_id: "other" })),
    /codex-cli|adapter/u,
  );
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({ unexpected: true })),
    /unsupported fields/u,
  );
});

test("launch rejects noncanonical paths and session id drift", () => {
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({ project_path: "../project" })),
    /project_path|canonical/u,
  );
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({ session_id: "../escape" })),
    /session_id|path-safe/u,
  );
  assert.doesNotThrow(
    () => validateAdaptiveSessionLaunch(launch({ state_dir: "/tmp/other-harness-state" })),
  );
});

test("launch rejects policy context input and manifest digest drift", () => {
  const value = launch();
  for (const drift of [
    { skill_manifest_sha256: hash("5") },
    { task_input_sha256: hash("6") },
    { policy_sha256: hash("7") },
    { context_pack_sha256: hash("8") },
  ]) {
    assert.throws(
      () => validateAdaptiveSessionLaunch(launch(drift)),
      /drifted fields|digest/u,
    );
  }

  const otherPack = { ...value.context_pack, total_bytes: value.context_pack.total_bytes + 1 };
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({
      task_input: codexTaskInput(otherPack),
      task_input_sha256: sha256CanonicalJSON(codexTaskInput(otherPack)),
    })),
    /ContextPack|context_pack/u,
  );
});

test("launch rejects unsafe model and reasoning aliases", () => {
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({
      policy: policy({
        routes: [{
          ...policy().routes[0],
          model_id: "../model",
        }],
      }),
    })),
    /model_id|alias/u,
  );
  assert.throws(
    () => validateAdaptiveSessionLaunch(launch({
      policy: policy({
        routes: [{
          ...policy().routes[0],
          reasoning_effort: "high; rm -rf .",
        }],
      }),
    })),
    /reasoning_effort|alias/u,
  );
});

test("launch is sole authority for adaptive input and child records", () => {
  const value = validateAdaptiveSessionLaunch(launch());
  const launchSha256 = sha256CanonicalJSONLine(value);
  const input = {
    schema_version: { major: 1 },
    session_id: value.session_id,
    policy: value.policy,
    policy_sha256: value.policy_sha256,
    context_pack: value.context_pack,
    context_pack_sha256: value.context_pack_sha256,
    transient_infra_retry_codes: value.transient_infra_retry_codes,
    launch_sha256: launchSha256,
  };
  assert.doesNotThrow(() => assertAdaptiveInputMatchesLaunch(input, value));
  assert.throws(
    () => assertAdaptiveInputMatchesLaunch({ ...input, policy_sha256: hash("9") }, value),
    /launch contract/u,
  );
  assert.throws(
    () => assertAdaptiveInputMatchesLaunch({ ...input, launch_sha256: hash("8") }, value),
    /launch contract/u,
  );

  assert.deepEqual(assertChildManifestMatchesLaunch(value.skill_manifest, value), value.skill_manifest);
  assert.throws(
    () => assertChildManifestMatchesLaunch({ ...value.skill_manifest, manifest_id: "other" }, value),
    /launch contract/u,
  );

  const executorInput = {
    schema_version: { major: 1 },
    run_id: "session-launch-child-1",
    manifest_sha256: value.skill_manifest_sha256,
    source_snapshot_sha256: value.context_pack.source_snapshot_sha256,
    executor_kind: "codex",
    input: value.task_input,
  };
  assert.deepEqual(assertChildExecutorInputMatchesLaunch(executorInput, value), executorInput);
  assert.throws(
    () => assertChildExecutorInputMatchesLaunch({ ...executorInput, manifest_sha256: hash("0") }, value),
    /launch contract/u,
  );

  const routeSelection = {
    schema_version: { major: 1 },
    policy_id: value.policy.policy_id,
    policy_sha256: value.policy_sha256,
    features_sha256: sha256CanonicalJSON({
      context_bytes: value.context_pack.total_bytes,
      allowed_path_count: 1,
      verifier_kind: "command-verifier",
      risk_tier: value.risk_tier,
    }),
    features: {
      context_bytes: value.context_pack.total_bytes,
      allowed_path_count: 1,
      verifier_kind: "command-verifier",
      risk_tier: value.risk_tier,
    },
    route_id: "codex-initial",
    route_index: 0,
    reason: "initial",
    adapter_id: "codex-cli",
    model_id: "gpt-5.5",
    reasoning_effort: "medium",
    timeout_ms: 30_000,
    reason_codes: ["default"],
  };
  assert.deepEqual(assertRouteSelectionMatchesLaunch(routeSelection, value), routeSelection);
  assert.throws(
    () => assertRouteSelectionMatchesLaunch({ ...routeSelection, model_id: "other" }, value),
    /launch contract/u,
  );
});
