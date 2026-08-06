import { resolve } from "node:path";
import {
  assertEnum,
  assertRequiredFields,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { validateCodexTaskInput } from "./codex-executor.js";
import { validateContextPack } from "./context-pack.js";
import { usageError } from "./errors.js";
import { validateExecutionPolicy, validateRouteSelection } from "./execution-policy.js";
import { validateExecutorInput } from "./executor.js";
import { validateSkillManifest } from "./skill-manifest.js";
import { sha256CanonicalJSON, sha256CanonicalJSONLine } from "../core/hash.js";

export const ADAPTIVE_SESSION_LAUNCH_REQUIRED_FIELDS = Object.freeze([
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

export const ADAPTIVE_SESSION_LAUNCH_RISK_TIERS = Object.freeze([
  "low",
  "medium",
  "high",
]);

const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertCanonicalAbsolutePath(value, field) {
  assertString(value, field);
  if (resolve(value) !== value) {
    throw usageError(`${field} must be a canonical absolute path.`, { field });
  }
  return value;
}

function assertSafeAlias(value, field) {
  assertString(value, field);
  if (!SAFE_ALIAS_PATTERN.test(value)) {
    throw usageError(`${field} contains an unsafe alias.`, { field });
  }
}

function validateSortedUniqueTransientCodes(value) {
  if (!Array.isArray(value)) {
    throw usageError("transient_infra_retry_codes must be an array.", {
      field: "transient_infra_retry_codes",
    });
  }
  let previous = null;
  for (const code of value) {
    assertSafeAlias(code, "transient_infra_retry_codes");
    if (previous !== null && code <= previous) {
      throw usageError(
        "transient_infra_retry_codes must be unique and code-unit sorted.",
        { field: "transient_infra_retry_codes" },
      );
    }
    previous = code;
  }
  return deepFreeze([...value]);
}

function assertPolicyCompatibleWithLaunch(policy, manifest) {
  if (manifest.policy_id !== policy.policy_id) {
    throw usageError("Launch manifest policy_id must match policy policy_id.");
  }
  if (!manifest.executor_kinds.includes("codex")) {
    throw usageError("Launch manifest must admit the codex executor kind.");
  }
  for (const route of policy.routes) {
    if (route.adapter_id !== "codex-cli") {
      throw usageError("Launch policy routes must use adapter_id 'codex-cli'.");
    }
    assertSafeAlias(route.model_id, "route.model_id");
    assertSafeAlias(route.reasoning_effort, "route.reasoning_effort");
  }
}

function exactLaunch({
  sessionId,
  projectPath,
  stateDir,
  skillManifest,
  taskInput,
  policy,
  contextPack,
  riskTier,
  transientInfraRetryCodes,
}) {
  return deepFreeze({
    schema_version: { major: 1 },
    session_id: sessionId,
    project_path: projectPath,
    state_dir: stateDir,
    skill_manifest: skillManifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(skillManifest),
    task_input: taskInput,
    task_input_sha256: sha256CanonicalJSON(taskInput),
    policy,
    policy_sha256: sha256CanonicalJSON(policy),
    context_pack: contextPack,
    context_pack_sha256: sha256CanonicalJSON(contextPack),
    risk_tier: riskTier,
    transient_infra_retry_codes: transientInfraRetryCodes,
    adapter_id: "codex-cli",
  });
}

export function validateAdaptiveSessionLaunch(value, options = {}) {
  validateContractBase(
    value,
    ADAPTIVE_SESSION_LAUNCH_REQUIRED_FIELDS,
    "AdaptiveSessionLaunch",
    options,
  );
  const unsupported = Object.keys(value)
    .filter((field) => !ADAPTIVE_SESSION_LAUNCH_REQUIRED_FIELDS.includes(field));
  if (unsupported.length > 0) {
    throw usageError("AdaptiveSessionLaunch contains unsupported fields.", {
      fields: unsupported.sort(),
    });
  }
  assertString(value.session_id, "session_id");
  if (!SESSION_ID_PATTERN.test(value.session_id)) {
    throw usageError("session_id must be a path-safe identifier.", {
      field: "session_id",
    });
  }
  const projectPath = assertCanonicalAbsolutePath(value.project_path, "project_path");
  const stateDir = assertCanonicalAbsolutePath(value.state_dir, "state_dir");
  const skillManifest = validateSkillManifest(value.skill_manifest);
  const taskInput = validateCodexTaskInput(value.task_input);
  const policy = validateExecutionPolicy(value.policy);
  const contextPack = validateContextPack(value.context_pack);
  assertSha256Hex(value.skill_manifest_sha256, "skill_manifest_sha256");
  assertSha256Hex(value.task_input_sha256, "task_input_sha256");
  assertSha256Hex(value.policy_sha256, "policy_sha256");
  assertSha256Hex(value.context_pack_sha256, "context_pack_sha256");
  assertEnum(value.risk_tier, "risk_tier", ADAPTIVE_SESSION_LAUNCH_RISK_TIERS);
  if (value.adapter_id !== "codex-cli") {
    throw usageError("AdaptiveSessionLaunch adapter_id must be 'codex-cli'.");
  }
  if (taskInput.context_pack === undefined) {
    throw usageError("Launch Codex task input must embed its ContextPack.");
  }
  if (sha256CanonicalJSON(taskInput.context_pack) !== sha256CanonicalJSON(contextPack)) {
    throw usageError("Launch Codex task input ContextPack does not match launch ContextPack.");
  }
  assertPolicyCompatibleWithLaunch(policy, skillManifest);
  const transientInfraRetryCodes = validateSortedUniqueTransientCodes(
    value.transient_infra_retry_codes,
  );
  const expected = exactLaunch({
    sessionId: value.session_id,
    projectPath,
    stateDir,
    skillManifest,
    taskInput,
    policy,
    contextPack,
    riskTier: value.risk_tier,
    transientInfraRetryCodes,
  });
  if (
    expected.skill_manifest_sha256 !== value.skill_manifest_sha256 ||
    expected.task_input_sha256 !== value.task_input_sha256 ||
    expected.policy_sha256 !== value.policy_sha256 ||
    expected.context_pack_sha256 !== value.context_pack_sha256 ||
    sha256CanonicalJSON(expected) !== sha256CanonicalJSON(value)
  ) {
    throw usageError("AdaptiveSessionLaunch contains unsupported or drifted fields.");
  }
  return expected;
}

export const freezeAdaptiveSessionLaunch = validateAdaptiveSessionLaunch;

export function assertAdaptiveInputMatchesLaunch(input, launch) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  if (
    input?.session_id !== frozenLaunch.session_id ||
    input.launch_sha256 !== sha256CanonicalJSONLine(frozenLaunch) ||
    input.policy_sha256 !== frozenLaunch.policy_sha256 ||
    input.context_pack_sha256 !== frozenLaunch.context_pack_sha256 ||
    sha256CanonicalJSON(input.policy) !== frozenLaunch.policy_sha256 ||
    sha256CanonicalJSON(input.context_pack) !== frozenLaunch.context_pack_sha256 ||
    sha256CanonicalJSON(input.transient_infra_retry_codes) !==
      sha256CanonicalJSON(frozenLaunch.transient_infra_retry_codes)
  ) {
    throw usageError("Adaptive session input is not bound to its launch contract.");
  }
  return frozenLaunch;
}

export function assertChildManifestMatchesLaunch(skillManifest, launch) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  const manifest = validateSkillManifest(skillManifest);
  if (sha256CanonicalJSONLine(manifest) !== frozenLaunch.skill_manifest_sha256) {
    throw usageError("Child skill manifest is not bound to its launch contract.");
  }
  return manifest;
}

export function assertChildExecutorInputMatchesLaunch(executorInput, launch) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  const input = validateExecutorInput(executorInput);
  if (
    input.manifest_sha256 !== frozenLaunch.skill_manifest_sha256 ||
    input.source_snapshot_sha256 !== frozenLaunch.context_pack.source_snapshot_sha256 ||
    input.executor_kind !== "codex" ||
    sha256CanonicalJSON(input.input) !== frozenLaunch.task_input_sha256
  ) {
    throw usageError("Child executor input is not bound to its launch contract.");
  }
  return input;
}

export function assertRouteSelectionMatchesLaunch(routeSelection, launch) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  const selection = validateRouteSelection(routeSelection);
  const route = frozenLaunch.policy.routes[selection.route_index];
  if (
    selection.policy_sha256 !== frozenLaunch.policy_sha256 ||
    selection.features.context_bytes !== frozenLaunch.context_pack.total_bytes ||
    selection.features.risk_tier !== frozenLaunch.risk_tier ||
    route === undefined ||
    route.route_id !== selection.route_id ||
    route.reason !== selection.reason ||
    route.adapter_id !== selection.adapter_id ||
    route.model_id !== selection.model_id ||
    route.reasoning_effort !== selection.reasoning_effort ||
    route.timeout_ms !== selection.timeout_ms
  ) {
    throw usageError("Route selection is not bound to its launch contract.");
  }
  return selection;
}

export function launchPolicyAliases(launch) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  return deepFreeze({
    model_ids: [...new Set(frozenLaunch.policy.routes.map((route) => route.model_id))].sort(),
    reasoning_efforts: [
      ...new Set(frozenLaunch.policy.routes.map((route) => route.reasoning_effort)),
    ].sort(),
  });
}
