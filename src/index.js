export { product } from "./product.js";

export {
  HarnessContractError,
  infraError,
  notFound,
  persistedSchemaUnsupported,
  safetyRefusal,
  usageError,
  verificationFailed,
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
  DETERMINISTIC_EXECUTOR_INPUT_REQUIRED_FIELDS,
  DETERMINISTIC_EXECUTOR_RESULT_REQUIRED_FIELDS,
  freezeDeterministicExecutorInput,
  freezeDeterministicExecutorResult,
  validateDeterministicExecutorInput,
  validateDeterministicExecutorResult,
} from "./contracts/deterministic-executor.js";
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
export {
  compareCodeUnit,
  assertInsideRoot,
  createProjectSnapshot,
  isExcludedRelativePath,
  normalizeRelativePath,
  readRegularFileNoFollow,
} from "./core/snapshot.js";
export {
  WORKFLOW_STEP_IDS,
  compileWorkflowPlan,
} from "./core/workflow-compiler.js";
export {
  applyDeterministicChanges,
  assertDeterministicResultMatchesWorkspace,
  createIsolatedWorkspace,
} from "./core/workspace.js";
export {
  deterministicRunDebugPaths,
  resumeDeterministicHarness,
  runDeterministicHarness,
} from "./core/run-orchestrator.js";
export {
  frozenRunInputPaths,
  readFrozenRunInputs,
  runArtifactRoot,
  runDirectory,
  runWorkspacePath,
  writeFailedRunEvidence,
  writeFrozenRunInputs,
  writeRunFailure,
} from "./core/run-artifacts.js";
export {
  evidencePaths,
  readEvidenceBundle,
  writeEvidenceBundle,
} from "./core/evidence.js";
export {
  VerificationRollbackError,
  captureOriginalBytes,
  restoreOriginalBytes,
} from "./core/rollback.js";
export {
  applyEvidenceBundle,
} from "./core/apply.js";
export {
  SPRING_VERIFIER_ADAPTER_ID,
  runSpringVerifier,
} from "./adapters/spring-verifier.js";
export {
  parseCliArgs,
} from "./cli/args.js";
export {
  executeCliCommand,
} from "./cli/commands.js";
export {
  formatJsonlError,
  formatJsonlSuccess,
} from "./cli/jsonl.js";
export {
  cliHelpText,
  runCli,
} from "./cli/main.js";
