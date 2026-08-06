import assert from "node:assert/strict";
import test from "node:test";
import { codexExecCommand } from "../../../src/adapters/codex-transport.js";
import { createAdaptiveCodexRegistry } from "../../../src/adapters/adaptive-codex-registry.js";
import {
  resolveExecutionRoute,
  selectExecutionRoute,
} from "../../../src/core/route-selector.js";
import {
  sha256CanonicalJSON,
  sha256CanonicalJSONLine,
  sha256Hex,
} from "../../../src/core/hash.js";

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function policy(overrides = {}) {
  return {
    schema_version: { major: 1 },
    policy_id: "codex-registry-policy",
    attempt_budget: 1,
    token_budget: 1000,
    wall_budget_ms: 30_000,
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

function launch(overrides = {}) {
  const executionPolicy = policy();
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
  const packPolicy = {
    max_files: 1,
    max_excerpts: 1,
    max_total_bytes: 100,
    max_file_bytes: 100,
    max_source_file_bytes: 100,
  };
  const contextPack = {
    schema_version: { major: 1 },
    source_snapshot_sha256: digest("source"),
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
      source_sha256: digest("entry"),
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
  const skillManifest = {
    schema_version: { major: 1 },
    manifest_id: "codex-skill",
    name: "Codex skill",
    policy_id: "codex-registry-policy",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task/v1",
    policy_rules: {},
  };
  const taskInput = {
    task: "Change src/app.js.",
    allowed_paths: ["src/app.js"],
    context_pack: contextPack,
  };
  return {
    schema_version: { major: 1 },
    session_id: "session-registry",
    project_path: "/tmp/project",
    state_dir: "/tmp/state",
    skill_manifest: skillManifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(skillManifest),
    task_input: taskInput,
    task_input_sha256: sha256CanonicalJSON(taskInput),
    policy: executionPolicy,
    policy_sha256: sha256CanonicalJSON(executionPolicy),
    context_pack: contextPack,
    context_pack_sha256: sha256CanonicalJSON(contextPack),
    risk_tier: "low",
    transient_infra_retry_codes: [],
    adapter_id: "codex-cli",
    ...overrides,
  };
}

function selection(overrides = {}) {
  const features = {
    context_bytes: Buffer.byteLength("export const value = 1;\n", "utf8"),
    allowed_path_count: 1,
    verifier_kind: "command-verifier",
    risk_tier: "low",
  };
  return {
    schema_version: { major: 1 },
    policy_id: "codex-registry-policy",
    policy_sha256: sha256CanonicalJSON(policy()),
    features_sha256: sha256CanonicalJSON(features),
    features,
    route_id: "codex-initial",
    route_index: 0,
    reason: "initial",
    adapter_id: "codex-cli",
    model_id: "gpt-5.5",
    reasoning_effort: "medium",
    timeout_ms: 30_000,
    reason_codes: ["default"],
    ...overrides,
  };
}

test("adaptive codex registry exposes exactly codex-cli", () => {
  const registry = createAdaptiveCodexRegistry(launch(), selection());

  assert.deepEqual(Object.keys(registry), ["codex-cli"]);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(registry["codex-cli"].executor_kind, "codex");
  assert.deepEqual(registry["codex-cli"].model_ids, ["gpt-5.5"]);
  assert.deepEqual(registry["codex-cli"].reasoning_efforts, ["medium"]);
  assert.equal(typeof registry["codex-cli"].executor_input_validator, "function");
  assert.equal(typeof registry["codex-cli"].create_executor, "function");
});

test("selected model and reasoning map to codex transport command configuration", () => {
  const command = codexExecCommand({
    workspace: "/tmp/project",
    model: "gpt-5.5",
    reasoningEffort: "medium",
  });

  assert.equal(command.includes("--model"), true);
  assert.equal(command[command.indexOf("--model") + 1], "gpt-5.5");
  assert.equal(command.includes("model_reasoning_effort=medium"), true);

  let transportOptions;
  const executor = Object.freeze({ kind: "test-executor" });
  const registry = createAdaptiveCodexRegistry({
    launch: launch(),
    selection: selection(),
    createTransport(options) {
      transportOptions = options;
      return Object.freeze({ kind: "test-transport" });
    },
    createExecutor({ transport }) {
      assert.equal(transport.kind, "test-transport");
      return executor;
    },
  });

  assert.equal(registry["codex-cli"].create_executor(), executor);
  assert.deepEqual(transportOptions, {
    model: "gpt-5.5",
    reasoningEffort: "medium",
  });
});

test("unknown adapter model and reasoning fail before transport creation", () => {
  const registry = createAdaptiveCodexRegistry(launch(), selection());

  assert.throws(
    () => createAdaptiveCodexRegistry(launch(), selection({ adapter_id: "other" })),
    /adapter|launch contract|unavailable/u,
  );
  assert.throws(
    () => resolveExecutionRoute(selection({ model_id: "unknown-model" }), registry),
    (error) => error.code === "infra_error" && /model alias is unavailable/u.test(error.message),
  );
  assert.throws(
    () => resolveExecutionRoute(selection({ reasoning_effort: "extreme" }), registry),
    (error) => error.code === "infra_error" && /reasoning alias is unavailable/u.test(error.message),
  );
});

test("registry creates no dynamic loading surface", () => {
  const registry = createAdaptiveCodexRegistry(launch(), selection());

  assert.equal(registry.openai, undefined);
  assert.equal(registry.anthropic, undefined);
  assert.equal(registry["codex-cli"].module_path, undefined);
});

test("registry composes with selected codex route aliases", () => {
  const routePolicy = policy({
    routes: [{
      ...policy().routes[0],
      model_id: "gpt-5.6-sol",
      reasoning_effort: "high",
    }],
  });
  const routeLaunch = launch({
    policy: routePolicy,
    policy_sha256: sha256CanonicalJSON(routePolicy),
  });
  const routeSelection = selectExecutionRoute({
    policy: routePolicy,
    features: {
      context_bytes: Buffer.byteLength("export const value = 1;\n", "utf8"),
      allowed_path_count: 1,
      verifier_kind: "command-verifier",
      risk_tier: "low",
    },
  });
  const registry = createAdaptiveCodexRegistry(routeLaunch, routeSelection);
  const resolved = resolveExecutionRoute(routeSelection, registry);

  assert.equal(resolved.route_selection.model_id, "gpt-5.6-sol");
  assert.equal(resolved.route_selection.reasoning_effort, "high");
  assert.deepEqual(registry["codex-cli"].model_ids, ["gpt-5.6-sol"]);
  assert.deepEqual(registry["codex-cli"].reasoning_efforts, ["high"]);
});
