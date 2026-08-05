import {
  EXECUTOR_KINDS,
  assertEnum,
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";
import { validateRouteSelection } from "./execution-policy.js";

export const WORKFLOW_PLAN_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "manifest_sha256",
  "source_snapshot_sha256",
  "executor_kind",
  "steps",
  "expected_result",
]);

export function validateWorkflowPlan(value, options = {}) {
  validateContractBase(value, WORKFLOW_PLAN_REQUIRED_FIELDS, "WorkflowPlan", options);
  assertString(value.run_id, "run_id");
  assertSha256Hex(value.manifest_sha256, "manifest_sha256");
  assertSha256Hex(value.source_snapshot_sha256, "source_snapshot_sha256");
  assertEnum(value.executor_kind, "executor_kind", EXECUTOR_KINDS);
  if (!Array.isArray(value.steps)) {
    throw usageError("steps must be an array.", { field: "steps" });
  }
  assertObject(value.expected_result, "expected_result");
  if (value.route_selection !== undefined) {
    validateRouteSelection(value.route_selection, options);
    if (value.route_selection.adapter_id.length === 0) {
      throw usageError("WorkflowPlan route selection adapter is invalid.");
    }
  }
  return deepFreeze(structuredClone(value));
}

export const freezeWorkflowPlan = validateWorkflowPlan;
