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
