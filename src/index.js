export const product = Object.freeze({
  name: "verifiable-agent-harness",
  version: "0.0.0-development",
});

export {
  HarnessContractError,
  persistedSchemaUnsupported,
  safetyRefusal,
  usageError,
} from "./contracts/errors.js";
export {
  SUPPORTED_SCHEMA_MAJOR,
  assertSupportedSchemaVersion,
  schemaVersion,
} from "./contracts/schema-version.js";
export {
  EXECUTOR_KINDS,
  deepFreeze,
} from "./contracts/common.js";
export {
  SKILL_MANIFEST_REQUIRED_FIELDS,
  freezeSkillManifest,
  validateSkillManifest,
} from "./contracts/skill-manifest.js";
export {
  WORKFLOW_PLAN_REQUIRED_FIELDS,
  freezeWorkflowPlan,
  validateWorkflowPlan,
} from "./contracts/workflow-plan.js";
export {
  RUN_SPEC_REQUIRED_FIELDS,
  freezeRunSpec,
  validateRunSpec,
} from "./contracts/run-spec.js";
export {
  LIFECYCLE_STATES,
  RUN_STATE_IMMUTABLE_FIELDS,
  RUN_STATE_OPTIONAL_FIELDS,
  RUN_STATE_REQUIRED_FIELDS,
  freezeRunState,
  validateRunState,
} from "./contracts/run-state.js";
export {
  EVIDENCE_RECEIPT_REQUIRED_FIELDS,
  freezeEvidenceReceipt,
  validateEvidenceReceipt,
} from "./contracts/evidence-receipt.js";
export {
  canonicalJSONBytes,
  canonicalJSONLine,
  canonicalJSONLineBytes,
  canonicalJSONString,
} from "./core/canonical-json.js";
export {
  sha256CanonicalJSON,
  sha256CanonicalJSONLine,
  sha256Hex,
} from "./core/hash.js";
export {
  LIFECYCLE_TRANSITIONS,
  advanceRunState,
  assertLifecycleGuards,
  assertLifecycleTransition,
  assertRunStateImmutableFields,
  canTransitionLifecycle,
} from "./core/lifecycle.js";
export {
  advanceStoredRunState,
  assertResumeRevalidation,
  readRunState,
  runStateDigestPath,
  runStatePath,
  writeRunState,
} from "./core/state-store.js";
