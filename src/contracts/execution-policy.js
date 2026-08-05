import {
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
  }
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
