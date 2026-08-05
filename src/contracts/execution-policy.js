import {
  assertSha256Hex,
  assertStringArray,
  assertEnum,
  assertObject,
  assertRequiredFields,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";

export const ADAPTIVE_ROUTE_REASONS = Object.freeze([
  "initial",
  "verifier_failure",
  "transient_infra_retry",
]);

export const ROUTE_RISK_TIERS = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
]);

export const ROUTE_SELECTION_REASON_CODES = Object.freeze([
  "allowed_path_count",
  "context_bytes",
  "default",
  "risk_tier",
  "verifier_kind",
]);

export const ROUTE_SELECTION_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "policy_id",
  "policy_sha256",
  "features_sha256",
  "route_id",
  "route_index",
  "reason",
  "adapter_id",
  "model_id",
  "reasoning_effort",
  "timeout_ms",
  "reason_codes",
]);

export const EXECUTION_POLICY_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "policy_id",
  "attempt_budget",
  "token_budget",
  "wall_budget_ms",
  "routes",
]);

export const EXECUTION_POLICY_ROUTE_REQUIRED_FIELDS = Object.freeze([
  "route_id",
  "reason",
  "adapter_id",
  "model_id",
  "reasoning_effort",
  "timeout_ms",
]);

function assertPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`${field} must be a positive safe integer.`, { field });
  }
}

function assertRoutes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError("routes must be a non-empty array.", { field: "routes" });
  }

  const routeIds = new Set();
  for (const route of value) {
    assertRequiredFields(route, EXECUTION_POLICY_ROUTE_REQUIRED_FIELDS, "route");
    assertString(route.route_id, "route.route_id");
    if (routeIds.has(route.route_id)) {
      throw usageError("routes must not contain duplicate route_id values.", {
        field: "routes.route_id",
      });
    }
    routeIds.add(route.route_id);

    assertEnum(route.reason, "route.reason", ADAPTIVE_ROUTE_REASONS);
    assertString(route.adapter_id, "route.adapter_id");
    assertString(route.model_id, "route.model_id");
    assertString(route.reasoning_effort, "route.reasoning_effort");
    assertPositiveSafeInteger(route.timeout_ms, "route.timeout_ms");
    if (route.match !== undefined) {
      assertObject(route.match, "route.match");
      const admittedFields = new Set([
        "max_context_bytes",
        "max_allowed_paths",
        "verifier_kinds",
        "risk_tiers",
      ]);
      for (const field of Object.keys(route.match)) {
        if (!admittedFields.has(field)) {
          throw usageError(`route.match contains unsupported field '${field}'.`, {
            field,
          });
        }
      }
      if (Object.keys(route.match).length === 0) {
        throw usageError("route.match must contain at least one constraint.");
      }
      if (route.match.max_context_bytes !== undefined) {
        assertPositiveSafeInteger(
          route.match.max_context_bytes,
          "route.match.max_context_bytes",
        );
      }
      if (route.match.max_allowed_paths !== undefined) {
        assertPositiveSafeInteger(
          route.match.max_allowed_paths,
          "route.match.max_allowed_paths",
        );
      }
      if (route.match.verifier_kinds !== undefined) {
        assertStringArray(route.match.verifier_kinds, "route.match.verifier_kinds");
      }
      if (route.match.risk_tiers !== undefined) {
        assertStringArray(
          route.match.risk_tiers,
          "route.match.risk_tiers",
          ROUTE_RISK_TIERS,
        );
      }
    }
  }
}

function assertNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError(`${field} must be a non-negative safe integer.`, { field });
  }
}

export function validateRouteSelection(value, options = {}) {
  validateContractBase(
    value,
    ROUTE_SELECTION_REQUIRED_FIELDS,
    "RouteSelection",
    options,
  );
  assertString(value.policy_id, "policy_id");
  assertSha256Hex(value.policy_sha256, "policy_sha256");
  assertSha256Hex(value.features_sha256, "features_sha256");
  assertString(value.route_id, "route_id");
  assertNonNegativeSafeInteger(value.route_index, "route_index");
  if (value.reason !== "initial") {
    throw usageError("One-attempt RouteSelection reason must be 'initial'.");
  }
  assertString(value.adapter_id, "adapter_id");
  assertString(value.model_id, "model_id");
  assertString(value.reasoning_effort, "reasoning_effort");
  assertPositiveSafeInteger(value.timeout_ms, "timeout_ms");
  assertStringArray(
    value.reason_codes,
    "reason_codes",
    ROUTE_SELECTION_REASON_CODES,
  );
  const sorted = [...value.reason_codes].sort();
  if (value.reason_codes.some((reason, index) => reason !== sorted[index])) {
    throw usageError("reason_codes must be code-unit sorted.");
  }
  return deepFreeze(structuredClone(value));
}

export function validateExecutionPolicy(value, options = {}) {
  validateContractBase(
    value,
    EXECUTION_POLICY_REQUIRED_FIELDS,
    "ExecutionPolicy",
    options,
  );
  assertString(value.policy_id, "policy_id");
  assertPositiveSafeInteger(value.attempt_budget, "attempt_budget");
  assertPositiveSafeInteger(value.token_budget, "token_budget");
  assertPositiveSafeInteger(value.wall_budget_ms, "wall_budget_ms");
  assertRoutes(value.routes);
  assertObject(value.schema_version, "schema_version");
  return deepFreeze(structuredClone(value));
}

export const freezeExecutionPolicy = validateExecutionPolicy;
