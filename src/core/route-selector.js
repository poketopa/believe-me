import {
  validateExecutionPolicy,
  validateRouteFeatures,
  validateRouteSelection,
} from "../contracts/execution-policy.js";
import { EXECUTOR_KINDS, deepFreeze } from "../contracts/common.js";
import { infraError, safetyRefusal, usageError } from "../contracts/errors.js";
import { sha256CanonicalJSON } from "./hash.js";
import { validateContextPack } from "../contracts/context-pack.js";

export function deriveRouteFeatures({
  contextPack,
  allowedPaths,
  verifierKind,
  riskTier,
}) {
  if (!Array.isArray(allowedPaths)) {
    throw usageError("allowedPaths must be an array.");
  }
  const paths = new Set();
  for (const path of allowedPaths) {
    if (typeof path !== "string" || path.length === 0 || paths.has(path)) {
      throw usageError("allowedPaths must contain unique non-empty strings.");
    }
    paths.add(path);
  }
  const pack = contextPack === undefined
    ? null
    : validateContextPack(contextPack);
  return validateRouteFeatures({
    context_bytes: pack?.total_bytes ?? 0,
    allowed_path_count: paths.size,
    verifier_kind: verifierKind,
    risk_tier: riskTier,
  });
}

function routeMatches(route, features) {
  if (route.reason !== "initial") {
    return false;
  }
  const match = route.match;
  if (match === undefined) {
    return true;
  }
  return (
    (match.max_context_bytes === undefined ||
      features.context_bytes <= match.max_context_bytes) &&
    (match.max_allowed_paths === undefined ||
      features.allowed_path_count <= match.max_allowed_paths) &&
    (match.verifier_kinds === undefined ||
      match.verifier_kinds.includes(features.verifier_kind)) &&
    (match.risk_tiers === undefined ||
      match.risk_tiers.includes(features.risk_tier))
  );
}

function reasonCodes(route) {
  if (route.match === undefined) {
    return ["default"];
  }
  const codes = [];
  if (route.match.max_allowed_paths !== undefined) codes.push("allowed_path_count");
  if (route.match.max_context_bytes !== undefined) codes.push("context_bytes");
  if (route.match.risk_tiers !== undefined) codes.push("risk_tier");
  if (route.match.verifier_kinds !== undefined) codes.push("verifier_kind");
  return codes.sort();
}

export function selectExecutionRoute({ policy, features }) {
  const frozenPolicy = validateExecutionPolicy(policy);
  const frozenFeatures = validateRouteFeatures(features);
  const routeIndex = frozenPolicy.routes.findIndex((route) =>
    routeMatches(route, frozenFeatures));
  if (routeIndex === -1) {
    throw safetyRefusal("Frozen execution policy has no matching initial route.", {
      policy_id: frozenPolicy.policy_id,
      features_sha256: sha256CanonicalJSON(frozenFeatures),
    });
  }
  const route = frozenPolicy.routes[routeIndex];
  return validateRouteSelection({
    schema_version: { major: 1 },
    policy_id: frozenPolicy.policy_id,
    policy_sha256: sha256CanonicalJSON(frozenPolicy),
    features_sha256: sha256CanonicalJSON(frozenFeatures),
    features: frozenFeatures,
    route_id: route.route_id,
    route_index: routeIndex,
    reason: route.reason,
    adapter_id: route.adapter_id,
    model_id: route.model_id,
    reasoning_effort: route.reasoning_effort,
    timeout_ms: route.timeout_ms,
    reason_codes: reasonCodes(route),
  });
}

function registryEntry(adapterRegistry, adapterId) {
  if (adapterRegistry instanceof Map) {
    return adapterRegistry.get(adapterId);
  }
  if (
    adapterRegistry !== null &&
    typeof adapterRegistry === "object" &&
    !Array.isArray(adapterRegistry)
  ) {
    return adapterRegistry[adapterId];
  }
  throw usageError("Route adapter registry must be an object or Map.");
}

export function resolveExecutionRoute(selection, adapterRegistry) {
  const frozenSelection = validateRouteSelection(selection);
  const entry = registryEntry(adapterRegistry, frozenSelection.adapter_id);
  if (entry === undefined) {
    throw infraError("Selected route adapter is unavailable.", {
      adapter_id: frozenSelection.adapter_id,
    });
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw usageError("Route adapter registry entry must be an object.");
  }
  if (!EXECUTOR_KINDS.includes(entry.executor_kind)) {
    throw usageError("Route adapter executor_kind is unsupported.", {
      executor_kind: entry.executor_kind,
    });
  }
  if (!Array.isArray(entry.model_ids) || !entry.model_ids.includes(frozenSelection.model_id)) {
    throw infraError("Selected route model alias is unavailable.", {
      adapter_id: frozenSelection.adapter_id,
      model_id: frozenSelection.model_id,
    });
  }
  if (
    !Array.isArray(entry.reasoning_efforts) ||
    !entry.reasoning_efforts.includes(frozenSelection.reasoning_effort)
  ) {
    throw infraError("Selected route reasoning alias is unavailable.", {
      adapter_id: frozenSelection.adapter_id,
      reasoning_effort: frozenSelection.reasoning_effort,
    });
  }
  if (typeof entry.create_executor !== "function") {
    throw usageError("Route adapter create_executor must be a function.");
  }
  const executor = entry.create_executor(frozenSelection);
  if (typeof executor !== "function") {
    throw usageError("Route adapter factory must return an executor function.");
  }
  if (
    entry.executor_input_validator !== undefined &&
    typeof entry.executor_input_validator !== "function"
  ) {
    throw usageError("Route adapter executor_input_validator must be a function.");
  }
  return Object.freeze({
    executor_kind: entry.executor_kind,
    executor,
    executor_input_validator: entry.executor_input_validator,
    route_selection: frozenSelection,
  });
}

export function createOneAttemptRoutedExecutor({ selection, adapterRegistry }) {
  const resolved = resolveExecutionRoute(selection, adapterRegistry);
  let invoked = false;
  const executor = async (request) => {
    if (invoked) {
      throw safetyRefusal("One-attempt routed executor cannot be invoked twice.");
    }
    invoked = true;
    const result = await resolved.executor(request);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw usageError("Selected route executor must return an object.");
    }
    return deepFreeze({
      ...structuredClone(result),
      route_selection: resolved.route_selection,
    });
  };
  return Object.freeze({
    ...resolved,
    executor,
  });
}
