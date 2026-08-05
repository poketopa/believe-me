import {
  EXECUTOR_KINDS,
  assertEnum,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";

export const LIFECYCLE_STATES = Object.freeze([
  "draft",
  "planned",
  "executing",
  "verified",
  "receipted",
  "approved",
  "applied",
  "rolled_back",
  "rejected",
]);

export const RUN_STATE_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "lifecycle_state",
  "manifest_sha256",
  "workflow_plan_sha256",
  "source_snapshot_sha256",
  "executor_kind",
  "artifact_root",
]);

export const RUN_STATE_OPTIONAL_FIELDS = Object.freeze([
  "receipt_sha256",
  "approval_sha256",
]);

export const RUN_STATE_IMMUTABLE_FIELDS = Object.freeze([
  "run_id",
  "manifest_sha256",
  "workflow_plan_sha256",
  "source_snapshot_sha256",
  "executor_kind",
  "artifact_root",
]);

export function validateRunState(value, options = {}) {
  validateContractBase(value, RUN_STATE_REQUIRED_FIELDS, "RunState", options);
  assertString(value.run_id, "run_id");
  assertEnum(value.lifecycle_state, "lifecycle_state", LIFECYCLE_STATES);
  assertSha256Hex(value.manifest_sha256, "manifest_sha256");
  assertSha256Hex(value.workflow_plan_sha256, "workflow_plan_sha256");
  assertSha256Hex(value.source_snapshot_sha256, "source_snapshot_sha256");
  assertEnum(value.executor_kind, "executor_kind", EXECUTOR_KINDS);
  assertString(value.artifact_root, "artifact_root");
  for (const field of RUN_STATE_OPTIONAL_FIELDS) {
    if (Object.hasOwn(value, field)) {
      assertSha256Hex(value[field], field);
    }
  }
  return deepFreeze(structuredClone(value));
}

export const freezeRunState = validateRunState;
