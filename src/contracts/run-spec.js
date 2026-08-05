import {
  EXECUTOR_KINDS,
  assertEnum,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";

export const RUN_SPEC_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "project_path",
  "state_dir",
  "skill_manifest_path",
  "input_path",
  "executor_kind",
]);

export function validateRunSpec(value, options = {}) {
  validateContractBase(value, RUN_SPEC_REQUIRED_FIELDS, "RunSpec", options);
  assertString(value.project_path, "project_path");
  assertString(value.state_dir, "state_dir");
  assertString(value.skill_manifest_path, "skill_manifest_path");
  assertString(value.input_path, "input_path");
  assertEnum(value.executor_kind, "executor_kind", EXECUTOR_KINDS);
  return deepFreeze(structuredClone(value));
}

export const freezeRunSpec = validateRunSpec;
