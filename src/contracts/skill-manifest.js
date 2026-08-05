import {
  EXECUTOR_KINDS,
  assertObject,
  assertString,
  assertStringArray,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { validateVerifierSpec } from "./verifier.js";

export const SKILL_MANIFEST_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "manifest_id",
  "name",
  "policy_id",
  "executor_kinds",
  "input_schema_ref",
  "policy_rules",
]);

export function validateSkillManifest(value, options = {}) {
  validateContractBase(value, SKILL_MANIFEST_REQUIRED_FIELDS, "SkillManifest", options);
  assertString(value.manifest_id, "manifest_id");
  assertString(value.name, "name");
  assertString(value.policy_id, "policy_id");
  assertStringArray(value.executor_kinds, "executor_kinds", EXECUTOR_KINDS);
  assertString(value.input_schema_ref, "input_schema_ref");
  assertObject(value.policy_rules, "policy_rules");
  if (Object.hasOwn(value, "verifier")) {
    validateVerifierSpec(value.verifier, options);
  }
  return deepFreeze(structuredClone(value));
}

export const freezeSkillManifest = validateSkillManifest;
