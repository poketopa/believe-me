import {
  assertEnum,
  assertObject,
  assertRequiredFields,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "../contracts/common.js";
import { usageError } from "../contracts/errors.js";

export const BENCHMARK_ARMS = Object.freeze(["direct_codex", "harness"]);
export const BENCHMARK_PAIR_ORDERS = Object.freeze(["direct_first", "harness_first"]);
export const BENCHMARK_ORDER_ALGORITHM = "sha256-task-alternating-v1";
export const BENCHMARK_TERMINAL_STATUSES = Object.freeze([
  "completed",
  "verification_failed",
  "safety_refusal",
  "infra_error",
  "timeout",
]);
export const BENCHMARK_VERIFICATION_STATUSES = Object.freeze([
  "passed",
  "failed",
  "not_run",
]);
export const BENCHMARK_FAILURE_PHASES = Object.freeze([
  "execution",
  "verification",
  "safety",
  "infra",
  "timeout",
  "orchestration",
]);

export const BENCHMARK_EXPERIMENT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "experiment_id",
  "seed",
  "order_algorithm",
  "analysis_cut_frozen",
  "provider",
]);
export const BENCHMARK_TASK_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "experiment_id",
  "pair_id",
  "task_id",
  "repeat_index",
  "project_ref",
  "task",
  "allowed_paths",
  "baseline_sha256",
]);
export const BENCHMARK_ARM_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "experiment",
  "task",
  "arm",
  "baseline_sha256",
  "observation",
]);
export const BENCHMARK_PAIR_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "experiment",
  "task",
  "baseline_sha256",
  "order",
  "provider_configuration_equivalent",
  "protocol_valid",
  "protocol_invalid_reasons",
  "direct_codex",
  "harness",
]);

export const BENCHMARK_PROTOCOL_INVALID_REASONS = Object.freeze([
  "provider_configuration_unobserved",
  "provider_configuration_mismatch",
  "unsafe_control_verifier_executed",
  "registered_protocol_deviation",
]);

export const COMPARISON_V2_VERSION = 2;
export const COMPARISON_V2_ORDER_ALGORITHM = "sha256-arm-alternating-v2";
export const COMPARISON_V2_ROLES = Object.freeze(["control", "treatment"]);
export const COMPARISON_V2_COST_OBSERVATION_STATUSES = Object.freeze([
  "observed_billed",
  "estimated",
]);
export const COMPARISON_V2_MISSING_REASONS = Object.freeze([
  "provider_not_reported",
  "execution_not_started",
  "component_not_run",
  "not_instrumented",
  "redacted",
  "currency_mismatch",
]);
export const COMPARISON_V2_PROTOCOL_INVALID_REASONS = Object.freeze([
  "provider_configuration_unobserved",
  "provider_configuration_mismatch",
  "policy_mismatch",
  "source_mismatch",
  "task_mismatch",
  "verifier_mismatch",
  "order_deviation",
  "registered_protocol_deviation",
]);

export const COMPARISON_V2_EXPERIMENT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "comparison_version",
  "comparison_id",
  "seed",
  "order_algorithm",
  "analysis_cut_frozen",
  "verifier_sha256",
  "corpus_sha256",
  "control",
  "treatment",
]);
export const COMPARISON_V2_TASK_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "comparison_version",
  "comparison_id",
  "pair_id",
  "task_id",
  "repeat_index",
  "project_ref",
  "source_sha256",
  "task_sha256",
]);
export const COMPARISON_V2_ARM_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "comparison_version",
  "experiment",
  "task",
  "role",
  "name",
  "provider_sha256",
  "policy_sha256",
  "configuration_sha256",
  "observation",
]);
export const COMPARISON_V2_PAIR_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "comparison_version",
  "experiment",
  "task",
  "order",
  "protocol_valid",
  "protocol_invalid_reasons",
  "control",
  "treatment",
]);

const normalizedPathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\\0]+$/u;

const usageFields = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);
const nullableTimingFields = Object.freeze([
  "codex_child_ms",
  "verification_ms",
  "orchestration_ms",
]);

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw usageError(`${field} must be a boolean.`, { field });
  }
}

function assertNullableString(value, field) {
  if (value !== null) {
    assertString(value, field);
  }
}

function assertNonnegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError(`${field} must be a nonnegative safe integer.`, { field });
  }
}

function assertPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`${field} must be a positive safe integer.`, { field });
  }
}

function assertSeed(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return;
  }
  assertString(value, "seed");
}

function assertStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw usageError(`${field} must be an array.`, { field });
  }
  const seen = new Set();
  for (const item of value) {
    assertString(item, field);
    if (seen.has(item)) {
      throw usageError(`${field} must not contain duplicates.`, { field });
    }
    seen.add(item);
  }
}

function assertAllowedPaths(value) {
  assertStringArray(value, "allowed_paths", { allowEmpty: false });
  for (const path of value) {
    if (
      path.length > 512 ||
      path.endsWith("/") ||
      !normalizedPathPattern.test(path)
    ) {
      throw usageError(
        "allowed_paths entries must be normalized relative POSIX paths.",
        { path },
      );
    }
  }
}

function assertSha256OrNullObject(value, field) {
  assertObject(value, field);
  for (const [key, hash] of Object.entries(value)) {
    assertString(key, `${field} key`);
    if (hash !== null) {
      assertSha256Hex(hash, `${field}.${key}`);
    }
  }
}

function assertProvider(value) {
  assertRequiredFields(
    value,
    ["adapter_id", "model", "reasoning_effort", "timeout_ms"],
    "provider",
  );
  assertString(value.adapter_id, "provider.adapter_id");
  assertNullableString(value.model, "provider.model");
  assertNullableString(value.reasoning_effort, "provider.reasoning_effort");
  assertPositiveSafeInteger(value.timeout_ms, "provider.timeout_ms");
}

function assertCodexUsageOrNull(value, missingReason) {
  if (value === null) {
    assertString(missingReason, "usage_missing_reason");
    return;
  }
  if (missingReason !== null) {
    throw usageError("usage_missing_reason must be null when usage is present.", {
      field: "usage_missing_reason",
    });
  }
  assertObject(value, "usage");
  for (const field of usageFields) {
    assertNonnegativeSafeInteger(value[field], `usage.${field}`);
  }
  if (
    value.cached_input_tokens > value.input_tokens ||
    value.reasoning_output_tokens > value.output_tokens ||
    value.total_tokens !== value.input_tokens + value.output_tokens
  ) {
    throw usageError("usage is internally inconsistent.", { field: "usage" });
  }
}

function assertTiming(value) {
  assertObject(value, "timing");
  assertNonnegativeSafeInteger(value.wall_ms, "timing.wall_ms");
  for (const field of nullableTimingFields) {
    const reasonField = `${field}_missing_reason`;
    const measured = value[field];
    const missingReason = value[reasonField];
    if (measured === null) {
      assertString(missingReason, `timing.${reasonField}`);
    } else {
      assertNonnegativeSafeInteger(measured, `timing.${field}`);
      if (missingReason !== null) {
        throw usageError(`timing.${reasonField} must be null when ${field} is present.`, {
          field: `timing.${reasonField}`,
        });
      }
    }
  }
}

function assertObservation(value) {
  assertRequiredFields(
    value,
    [
      "terminal_status",
      "verification_status",
      "verified_success",
      "unsafe_or_out_of_scope",
      "source_mutated_before_verification",
      "usage",
      "usage_missing_reason",
      "timing",
      "changed_paths",
      "artifact_hashes",
      "failure_phase",
    ],
    "Benchmark arm observation",
  );
  assertEnum(value.terminal_status, "terminal_status", BENCHMARK_TERMINAL_STATUSES);
  assertEnum(
    value.verification_status,
    "verification_status",
    BENCHMARK_VERIFICATION_STATUSES,
  );
  assertBoolean(value.verified_success, "verified_success");
  assertBoolean(value.unsafe_or_out_of_scope, "unsafe_or_out_of_scope");
  assertBoolean(
    value.source_mutated_before_verification,
    "source_mutated_before_verification",
  );
  assertCodexUsageOrNull(value.usage, value.usage_missing_reason);
  assertTiming(value.timing);
  assertStringArray(value.changed_paths, "changed_paths");
  assertSha256OrNullObject(value.artifact_hashes, "artifact_hashes");
  if (value.failure_phase !== null) {
    assertEnum(value.failure_phase, "failure_phase", BENCHMARK_FAILURE_PHASES);
  }
  if (
    value.verified_success &&
    (
      value.terminal_status !== "completed" ||
      value.verification_status !== "passed" ||
      value.unsafe_or_out_of_scope ||
      value.changed_paths.length === 0
    )
  ) {
    throw usageError(
      "verified_success requires a completed, verified, safe, non-empty candidate.",
    );
  }
  if (value.terminal_status === "completed" && !value.verified_success) {
    throw usageError("completed benchmark observations must be verified successes.");
  }
  if ((value.terminal_status === "completed") !== (value.failure_phase === null)) {
    throw usageError("failure_phase must be null exactly for completed observations.");
  }
  if (
    value.terminal_status === "safety_refusal" &&
    !value.unsafe_or_out_of_scope
  ) {
    throw usageError("safety_refusal observations must record an unsafe outcome.");
  }
}

function canonicalComparable(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalComparable);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalComparable(child)]),
    );
  }
  return value;
}

function assertSameRecord(left, right, field) {
  if (
    JSON.stringify(canonicalComparable(left)) !==
    JSON.stringify(canonicalComparable(right))
  ) {
    throw usageError(`pair ${field} must match both arm results.`, { field });
  }
}

function assertComparisonVersion(value, field = "comparison_version") {
  if (value !== COMPARISON_V2_VERSION) {
    throw usageError(`${field} must be exactly ${COMPARISON_V2_VERSION}.`, {
      field,
    });
  }
}

function assertComparisonArmDescriptor(value, role) {
  assertRequiredFields(
    value,
    ["name", "provider_sha256", "policy_sha256", "configuration_sha256"],
    `${role} descriptor`,
  );
  assertString(value.name, `${role}.name`);
  assertSha256Hex(value.provider_sha256, `${role}.provider_sha256`);
  assertSha256Hex(value.policy_sha256, `${role}.policy_sha256`);
  assertSha256Hex(value.configuration_sha256, `${role}.configuration_sha256`);
}

function assertComparisonMissingReason(value, field) {
  assertEnum(value, field, COMPARISON_V2_MISSING_REASONS);
}

function assertComparisonUsage(value, missingReason) {
  assertCodexUsageOrNull(value, missingReason);
  if (value === null) {
    assertComparisonMissingReason(missingReason, "usage_missing_reason");
  }
}

function assertComparisonCost(value, missingReason) {
  if (value === null) {
    assertComparisonMissingReason(missingReason, "cost_missing_reason");
    return;
  }
  if (missingReason !== null) {
    throw usageError("cost_missing_reason must be null when cost is present.", {
      field: "cost_missing_reason",
    });
  }
  assertRequiredFields(
    value,
    ["amount", "currency", "pricing_source", "observation_status"],
    "cost",
  );
  if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0) {
    throw usageError("cost.amount must be a nonnegative finite number.", {
      field: "cost.amount",
    });
  }
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) {
    throw usageError("cost.currency must be a three-letter uppercase currency code.", {
      field: "cost.currency",
    });
  }
  assertString(value.pricing_source, "cost.pricing_source");
  assertEnum(
    value.observation_status,
    "cost.observation_status",
    COMPARISON_V2_COST_OBSERVATION_STATUSES,
  );
}

function assertComparisonObservation(value) {
  assertRequiredFields(
    value,
    [
      "terminal_status",
      "verified_success",
      "unsafe_or_out_of_scope",
      "attempt_count",
      "usage",
      "usage_missing_reason",
      "wall_ms",
      "cost",
      "cost_missing_reason",
      "artifact_hashes",
    ],
    "Comparison v2 arm observation",
  );
  assertEnum(value.terminal_status, "terminal_status", BENCHMARK_TERMINAL_STATUSES);
  assertBoolean(value.verified_success, "verified_success");
  assertBoolean(value.unsafe_or_out_of_scope, "unsafe_or_out_of_scope");
  assertNonnegativeSafeInteger(value.attempt_count, "attempt_count");
  assertComparisonUsage(value.usage, value.usage_missing_reason);
  assertNonnegativeSafeInteger(value.wall_ms, "wall_ms");
  assertComparisonCost(value.cost, value.cost_missing_reason);
  assertSha256OrNullObject(value.artifact_hashes, "artifact_hashes");
  if (
    value.verified_success &&
    (value.terminal_status !== "completed" || value.unsafe_or_out_of_scope)
  ) {
    throw usageError(
      "verified_success requires a completed, safe comparison observation.",
    );
  }
  if (value.terminal_status === "completed" && !value.verified_success) {
    throw usageError("completed comparison observations must be verified successes.");
  }
  if (value.terminal_status === "completed" && value.attempt_count === 0) {
    throw usageError("completed comparison observations require an attempt.");
  }
  if (value.terminal_status === "verification_failed" && value.attempt_count === 0) {
    throw usageError("verification_failed comparison observations require an attempt.");
  }
  if (
    value.attempt_count === 0 &&
    (value.usage !== null || value.cost !== null)
  ) {
    throw usageError("zero-attempt comparison observations cannot report usage or cost.");
  }
  if (
    value.attempt_count > 0 &&
    (value.usage_missing_reason === "execution_not_started" ||
      value.cost_missing_reason === "execution_not_started")
  ) {
    throw usageError(
      "execution_not_started missing reasons require zero attempts.",
    );
  }
  if (
    value.terminal_status === "safety_refusal" &&
    !value.unsafe_or_out_of_scope
  ) {
    throw usageError("safety_refusal comparison observations must be unsafe.");
  }
}

export function validateBenchmarkExperiment(value, options = {}) {
  validateContractBase(
    value,
    BENCHMARK_EXPERIMENT_REQUIRED_FIELDS,
    "BenchmarkExperiment",
    options,
  );
  assertString(value.experiment_id, "experiment_id");
  assertSeed(value.seed);
  assertEnum(
    value.order_algorithm,
    "order_algorithm",
    [BENCHMARK_ORDER_ALGORITHM],
  );
  assertBoolean(value.analysis_cut_frozen, "analysis_cut_frozen");
  assertProvider(value.provider);
  return deepFreeze(structuredClone(value));
}

export function validateBenchmarkTask(value, options = {}) {
  validateContractBase(value, BENCHMARK_TASK_REQUIRED_FIELDS, "BenchmarkTask", options);
  assertString(value.experiment_id, "experiment_id");
  assertString(value.pair_id, "pair_id");
  assertString(value.task_id, "task_id");
  assertNonnegativeSafeInteger(value.repeat_index, "repeat_index");
  assertString(value.project_ref, "project_ref");
  assertString(value.task, "task");
  if (
    value.task.trim() === "" ||
    value.task.length > 50_000 ||
    value.task.includes("\0")
  ) {
    throw usageError("task exceeds the admitted benchmark prompt boundary.");
  }
  assertAllowedPaths(value.allowed_paths);
  assertSha256Hex(value.baseline_sha256, "baseline_sha256");
  return deepFreeze(structuredClone(value));
}

export function validateBenchmarkArmResult(value, options = {}) {
  validateContractBase(
    value,
    BENCHMARK_ARM_RESULT_REQUIRED_FIELDS,
    "BenchmarkArmResult",
    options,
  );
  const experiment = validateBenchmarkExperiment(value.experiment, options);
  const task = validateBenchmarkTask(value.task, options);
  if (experiment.experiment_id !== task.experiment_id) {
    throw usageError("task experiment_id must match experiment.", {
      field: "task.experiment_id",
    });
  }
  assertEnum(value.arm, "arm", BENCHMARK_ARMS);
  assertSha256Hex(value.baseline_sha256, "baseline_sha256");
  if (value.baseline_sha256 !== task.baseline_sha256) {
    throw usageError("arm baseline_sha256 must match task baseline_sha256.", {
      field: "baseline_sha256",
    });
  }
  assertObservation(value.observation);
  return deepFreeze(structuredClone(value));
}

export function validateBenchmarkPairResult(value, options = {}) {
  validateContractBase(
    value,
    BENCHMARK_PAIR_RESULT_REQUIRED_FIELDS,
    "BenchmarkPairResult",
    options,
  );
  const experiment = validateBenchmarkExperiment(value.experiment, options);
  const task = validateBenchmarkTask(value.task, options);
  if (experiment.experiment_id !== task.experiment_id) {
    throw usageError("pair task experiment_id must match experiment_id.", {
      field: "task.experiment_id",
    });
  }
  assertSha256Hex(value.baseline_sha256, "baseline_sha256");
  if (value.baseline_sha256 !== task.baseline_sha256) {
    throw usageError("pair baseline_sha256 must match task baseline_sha256.", {
      field: "baseline_sha256",
    });
  }
  assertEnum(value.order, "order", BENCHMARK_PAIR_ORDERS);
  assertBoolean(
    value.provider_configuration_equivalent,
    "provider_configuration_equivalent",
  );

  const direct = validateBenchmarkArmResult(value.direct_codex, options);
  const harness = validateBenchmarkArmResult(value.harness, options);
  if (direct.arm !== "direct_codex" || harness.arm !== "harness") {
    throw usageError("pair arms must be exactly direct_codex and harness.", {
      arms: [direct.arm, harness.arm],
    });
  }
  for (const armResult of [direct, harness]) {
    assertSameRecord(value.experiment, armResult.experiment, "experiment");
    assertSameRecord(value.task, armResult.task, "task");
    if (value.baseline_sha256 !== armResult.baseline_sha256) {
      throw usageError("pair baseline_sha256 must match both arm results.", {
        field: "baseline_sha256",
      });
    }
  }
  const directArtifacts = direct.observation.artifact_hashes;
  const harnessArtifacts = harness.observation.artifact_hashes;
  const declaredEquivalent =
    typeof directArtifacts.provider_configuration_sha256 === "string" &&
    directArtifacts.provider_configuration_sha256 ===
      harnessArtifacts.provider_configuration_sha256;
  const observedEquivalent =
    typeof directArtifacts.observed_provider_configuration_sha256 === "string" &&
    directArtifacts.observed_provider_configuration_sha256 ===
      harnessArtifacts.observed_provider_configuration_sha256;
  const derivedProviderEquivalent = declaredEquivalent && observedEquivalent;
  if (value.provider_configuration_equivalent !== derivedProviderEquivalent) {
    throw usageError(
      "pair provider_configuration_equivalent does not match arm evidence.",
      { field: "provider_configuration_equivalent" },
    );
  }
  assertBoolean(value.protocol_valid, "protocol_valid");
  assertStringArray(value.protocol_invalid_reasons, "protocol_invalid_reasons");
  for (const reason of value.protocol_invalid_reasons) {
    assertEnum(
      reason,
      "protocol_invalid_reasons",
      BENCHMARK_PROTOCOL_INVALID_REASONS,
    );
  }
  if (value.protocol_valid !== (value.protocol_invalid_reasons.length === 0)) {
    throw usageError(
      "protocol_valid must match whether protocol_invalid_reasons is empty.",
    );
  }
  const providerUnobserved =
    typeof directArtifacts.observed_provider_configuration_sha256 !== "string" ||
    typeof harnessArtifacts.observed_provider_configuration_sha256 !== "string";
  const expectedProviderReason = providerUnobserved
    ? "provider_configuration_unobserved"
    : derivedProviderEquivalent
      ? null
      : "provider_configuration_mismatch";
  if (
    expectedProviderReason !== null &&
    !value.protocol_invalid_reasons.includes(expectedProviderReason)
  ) {
    throw usageError(
      `protocol_invalid_reasons must include '${expectedProviderReason}'.`,
    );
  }
  if (
    expectedProviderReason === null &&
    value.protocol_invalid_reasons.some((reason) =>
      reason === "provider_configuration_unobserved" ||
      reason === "provider_configuration_mismatch"
    )
  ) {
    throw usageError(
      "provider protocol-invalid reasons must match arm evidence.",
    );
  }
  const unsafeControlVerifierExecuted =
    direct.observation.unsafe_or_out_of_scope &&
    (direct.observation.verification_status !== "not_run" ||
      directArtifacts.verification_sha256 !== null);
  if (
    unsafeControlVerifierExecuted &&
    !value.protocol_invalid_reasons.includes("unsafe_control_verifier_executed")
  ) {
    throw usageError(
      "unsafe direct-arm verification must be registered as a protocol deviation.",
    );
  }

  return deepFreeze(structuredClone(value));
}

export function validateComparisonV2Experiment(value, options = {}) {
  validateContractBase(
    value,
    COMPARISON_V2_EXPERIMENT_REQUIRED_FIELDS,
    "ComparisonV2Experiment",
    options,
  );
  assertComparisonVersion(value.comparison_version);
  assertString(value.comparison_id, "comparison_id");
  assertSeed(value.seed);
  assertEnum(
    value.order_algorithm,
    "order_algorithm",
    [COMPARISON_V2_ORDER_ALGORITHM],
  );
  assertBoolean(value.analysis_cut_frozen, "analysis_cut_frozen");
  assertSha256Hex(value.verifier_sha256, "verifier_sha256");
  assertSha256Hex(value.corpus_sha256, "corpus_sha256");
  assertComparisonArmDescriptor(value.control, "control");
  assertComparisonArmDescriptor(value.treatment, "treatment");
  if (value.control.name === value.treatment.name) {
    throw usageError("comparison arm names must be distinct.", {
      field: "control.name",
    });
  }
  return deepFreeze(structuredClone(value));
}

export function validateComparisonV2Task(value, options = {}) {
  validateContractBase(
    value,
    COMPARISON_V2_TASK_REQUIRED_FIELDS,
    "ComparisonV2Task",
    options,
  );
  assertComparisonVersion(value.comparison_version);
  assertString(value.comparison_id, "comparison_id");
  assertString(value.pair_id, "pair_id");
  assertString(value.task_id, "task_id");
  assertNonnegativeSafeInteger(value.repeat_index, "repeat_index");
  assertString(value.project_ref, "project_ref");
  assertSha256Hex(value.source_sha256, "source_sha256");
  assertSha256Hex(value.task_sha256, "task_sha256");
  return deepFreeze(structuredClone(value));
}

export function validateComparisonV2ArmResult(value, options = {}) {
  validateContractBase(
    value,
    COMPARISON_V2_ARM_RESULT_REQUIRED_FIELDS,
    "ComparisonV2ArmResult",
    options,
  );
  assertComparisonVersion(value.comparison_version);
  const experiment = validateComparisonV2Experiment(value.experiment, options);
  const task = validateComparisonV2Task(value.task, options);
  if (task.comparison_id !== experiment.comparison_id) {
    throw usageError("comparison task must bind the experiment comparison_id.", {
      field: "task.comparison_id",
    });
  }
  assertEnum(value.role, "role", COMPARISON_V2_ROLES);
  assertString(value.name, "name");
  assertSha256Hex(value.provider_sha256, "provider_sha256");
  assertSha256Hex(value.policy_sha256, "policy_sha256");
  assertSha256Hex(value.configuration_sha256, "configuration_sha256");
  const descriptor = experiment[value.role];
  for (const field of [
    "name",
    "provider_sha256",
    "policy_sha256",
    "configuration_sha256",
  ]) {
    if (value[field] !== descriptor[field]) {
      throw usageError(`comparison arm ${field} must match its experiment descriptor.`, {
        field,
        role: value.role,
      });
    }
  }
  assertComparisonObservation(value.observation);
  return deepFreeze(structuredClone(value));
}

export function validateComparisonV2PairResult(value, options = {}) {
  validateContractBase(
    value,
    COMPARISON_V2_PAIR_RESULT_REQUIRED_FIELDS,
    "ComparisonV2PairResult",
    options,
  );
  assertComparisonVersion(value.comparison_version);
  const experiment = validateComparisonV2Experiment(value.experiment, options);
  const task = validateComparisonV2Task(value.task, options);
  if (task.comparison_id !== experiment.comparison_id) {
    throw usageError("pair task must bind the experiment comparison_id.", {
      field: "task.comparison_id",
    });
  }
  assertStringArray(value.order, "order", { allowEmpty: false });
  if (
    value.order.length !== 2 ||
    !value.order.includes(experiment.control.name) ||
    !value.order.includes(experiment.treatment.name)
  ) {
    throw usageError("comparison order must contain each arm name exactly once.", {
      field: "order",
    });
  }
  assertBoolean(value.protocol_valid, "protocol_valid");
  assertStringArray(value.protocol_invalid_reasons, "protocol_invalid_reasons");
  for (const reason of value.protocol_invalid_reasons) {
    assertEnum(
      reason,
      "protocol_invalid_reasons",
      COMPARISON_V2_PROTOCOL_INVALID_REASONS,
    );
  }
  if (value.protocol_valid !== (value.protocol_invalid_reasons.length === 0)) {
    throw usageError(
      "protocol_valid must match whether protocol_invalid_reasons is empty.",
    );
  }

  const control = validateComparisonV2ArmResult(value.control, options);
  const treatment = validateComparisonV2ArmResult(value.treatment, options);
  if (control.role !== "control" || treatment.role !== "treatment") {
    throw usageError("comparison pair roles must be exactly control and treatment.");
  }
  for (const armResult of [control, treatment]) {
    assertSameRecord(value.experiment, armResult.experiment, "experiment");
    assertSameRecord(value.task, armResult.task, "task");
  }
  return deepFreeze(structuredClone(value));
}
