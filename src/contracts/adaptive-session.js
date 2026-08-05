import {
  assertEnum,
  assertObject,
  assertRequiredFields,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";
import {
  ADAPTIVE_ROUTE_REASONS,
  validateRouteFeatures,
} from "./execution-policy.js";
import { sha256CanonicalJSON } from "../core/hash.js";

export const ADAPTIVE_ATTEMPT_STATUSES = Object.freeze([
  "completed",
  "verification_failed",
  "safety_refusal",
  "infra_error",
  "timeout",
  "budget_exhausted",
]);

export const ADAPTIVE_VERIFICATION_STATUSES = Object.freeze([
  "passed",
  "failed",
  "not_run",
]);

export const ADAPTIVE_TELEMETRY_MISSING_REASONS = Object.freeze([
  "provider_not_reported",
  "adapter_not_instrumented",
  "not_started",
  "redacted",
  "not_applicable",
]);

export const ADAPTIVE_COST_OBSERVATION_STATUSES = Object.freeze([
  "observed_billed",
  "estimated",
]);

export const ADAPTIVE_TIMING_COMPONENTS = Object.freeze([
  "executor_ms",
  "verification_ms",
  "orchestration_ms",
  "localization_ms",
  "routing_ms",
]);

export const ADAPTIVE_SESSION_TERMINAL_REASONS = Object.freeze([
  "winner",
  "terminal_failure",
  "attempt_budget_exhausted",
  "token_budget_exhausted",
  "wall_budget_exhausted",
  "cost_budget_exhausted",
  "telemetry_missing",
  "no_authorized_route",
]);

export const ADAPTIVE_SESSION_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "session_id",
  "policy_sha256",
  "context_pack_sha256",
  "attempts",
  "aggregate_usage",
  "aggregate_usage_missing_reason",
  "aggregate_timing",
  "aggregate_cost",
  "aggregate_cost_missing_reason",
]);

export const ADAPTIVE_ATTEMPT_REQUIRED_FIELDS = Object.freeze([
  "attempt_index",
  "attempt_id",
  "child_run_id",
  "child_run_evidence_sha256",
  "route_id",
  "route_reason",
  "adapter_id",
  "model_id",
  "reasoning_effort",
  "context_pack_sha256",
  "status",
  "verification_status",
  "winner",
  "usage",
  "usage_missing_reason",
  "timing",
  "cost",
  "cost_missing_reason",
]);

const usageFields = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw usageError(`${field} must be a boolean.`, { field });
  }
}

function assertNonnegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError(`${field} must be a nonnegative safe integer.`, { field });
  }
}

function assertNonnegativeFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw usageError(`${field} must be a nonnegative finite number.`, { field });
  }
}

function assertMissingReason(value, field) {
  assertEnum(value, field, ADAPTIVE_TELEMETRY_MISSING_REASONS);
}

function assertUsage(value, missingReason, field) {
  if (value === null) {
    assertMissingReason(missingReason, `${field}_missing_reason`);
    return null;
  }
  if (missingReason !== null) {
    throw usageError(`${field}_missing_reason must be null when usage is present.`, {
      field: `${field}_missing_reason`,
    });
  }
  assertObject(value, field);

  for (const usageField of usageFields) {
    assertNonnegativeSafeInteger(value[usageField], `${field}.${usageField}`);
  }
  if (value.cached_input_tokens > value.input_tokens) {
    throw usageError(`${field}.cached_input_tokens cannot exceed input_tokens.`, {
      field,
    });
  }
  if (value.reasoning_output_tokens > value.output_tokens) {
    throw usageError(
      `${field}.reasoning_output_tokens cannot exceed output_tokens.`,
      { field },
    );
  }
  if (value.total_tokens < value.input_tokens + value.output_tokens) {
    throw usageError(
      `${field}.total_tokens cannot be below input_tokens + output_tokens.`,
      { field },
    );
  }
  return value;
}

function assertTiming(value, field) {
  assertObject(value, field);
  assertNonnegativeSafeInteger(value.wall_ms, `${field}.wall_ms`);
  for (const component of ADAPTIVE_TIMING_COMPONENTS) {
    const missingField = `${component}_missing_reason`;
    const measured = value[component];
    const missingReason = value[missingField];
    if (measured === null) {
      assertMissingReason(missingReason, `${field}.${missingField}`);
    } else {
      assertNonnegativeSafeInteger(measured, `${field}.${component}`);
      if (missingReason !== null) {
        throw usageError(
          `${field}.${missingField} must be null when ${component} is present.`,
          { field: `${field}.${missingField}` },
        );
      }
    }
  }
}

function assertCost(value, missingReason, field) {
  if (value === null) {
    assertMissingReason(missingReason, `${field}_missing_reason`);
    return null;
  }
  if (missingReason !== null) {
    throw usageError(`${field}_missing_reason must be null when cost is present.`, {
      field: `${field}_missing_reason`,
    });
  }
  assertObject(value, field);
  assertRequiredFields(
    value,
    ["observation_status", "amount", "currency", "pricing_source"],
    field,
  );
  assertEnum(
    value.observation_status,
    `${field}.observation_status`,
    ADAPTIVE_COST_OBSERVATION_STATUSES,
  );
  assertNonnegativeFiniteNumber(value.amount, `${field}.amount`);
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) {
    throw usageError(
      `${field}.currency must be a three-letter uppercase currency code.`,
      { field: `${field}.currency` },
    );
  }
  assertString(value.pricing_source, `${field}.pricing_source`);
  return value;
}

function assertAttempt(value, sessionContextDigest, expectedIndex) {
  assertRequiredFields(value, ADAPTIVE_ATTEMPT_REQUIRED_FIELDS, "attempt");
  assertNonnegativeSafeInteger(value.attempt_index, "attempt.attempt_index");
  if (value.attempt_index !== expectedIndex) {
    throw usageError("attempt_index must match the ordered attempt position.", {
      field: "attempt.attempt_index",
      expected_index: expectedIndex,
    });
  }
  assertString(value.attempt_id, "attempt.attempt_id");
  assertString(value.child_run_id, "attempt.child_run_id");
  if (value.attempt_claim_sha256 !== undefined) {
    assertSha256Hex(value.attempt_claim_sha256, "attempt.attempt_claim_sha256");
  }
  assertSha256Hex(
    value.child_run_evidence_sha256,
    "attempt.child_run_evidence_sha256",
  );
  assertString(value.route_id, "attempt.route_id");
  assertEnum(value.route_reason, "attempt.route_reason", ADAPTIVE_ROUTE_REASONS);
  assertString(value.adapter_id, "attempt.adapter_id");
  assertString(value.model_id, "attempt.model_id");
  assertString(value.reasoning_effort, "attempt.reasoning_effort");
  if (
    (value.route_features === undefined) !==
    (value.route_features_sha256 === undefined)
  ) {
    throw usageError(
      "attempt route features and digest must be present together.",
    );
  }
  if (value.route_features !== undefined) {
    const routeFeatures = validateRouteFeatures(value.route_features);
    assertSha256Hex(
      value.route_features_sha256,
      "attempt.route_features_sha256",
    );
    if (sha256CanonicalJSON(routeFeatures) !== value.route_features_sha256) {
      throw usageError("attempt route feature digest mismatch.");
    }
  }
  assertSha256Hex(value.context_pack_sha256, "attempt.context_pack_sha256");
  if (value.context_pack_sha256 !== sessionContextDigest) {
    throw usageError("attempt context_pack_sha256 must match session context.", {
      field: "attempt.context_pack_sha256",
    });
  }
  assertEnum(value.status, "attempt.status", ADAPTIVE_ATTEMPT_STATUSES);
  assertEnum(
    value.verification_status,
    "attempt.verification_status",
    ADAPTIVE_VERIFICATION_STATUSES,
  );
  assertBoolean(value.winner, "attempt.winner");
  if (value.retry_context_sha256 !== undefined) {
    if (value.retry_context_sha256 !== null) {
      assertSha256Hex(
        value.retry_context_sha256,
        "attempt.retry_context_sha256",
      );
    }
    if (
      (value.route_reason === "initial") !==
      (value.retry_context_sha256 === null)
    ) {
      throw usageError(
        "Initial attempts require null retry context; later attempts require a digest.",
        { field: "attempt.retry_context_sha256" },
      );
    }
  }
  if (value.failure_code !== undefined && value.failure_code !== null) {
    assertString(value.failure_code, "attempt.failure_code");
  }
  assertTiming(value.timing, "attempt.timing");
  const usage = assertUsage(
    value.usage,
    value.usage_missing_reason,
    "attempt.usage",
  );
  const cost = assertCost(
    value.cost,
    value.cost_missing_reason,
    "attempt.cost",
  );

  if (value.winner && value.verification_status !== "passed") {
    throw usageError("winner attempts must be verifier-passed.", {
      field: "attempt.winner",
    });
  }
  const expectedVerificationStatus = {
    completed: "passed",
    verification_failed: "failed",
    safety_refusal: "not_run",
    infra_error: "not_run",
    timeout: "not_run",
    budget_exhausted: "not_run",
  }[value.status];
  if (value.verification_status !== expectedVerificationStatus) {
    throw usageError(
      `${value.status} attempts require verification_status '${expectedVerificationStatus}'.`,
      { field: "attempt.verification_status" },
    );
  }

  return { usage, cost };
}

export function validateAdaptiveAttempt(
  value,
  { contextPackSha256, expectedIndex = value?.attempt_index } = {},
) {
  assertSha256Hex(contextPackSha256, "contextPackSha256");
  assertAttempt(value, contextPackSha256, expectedIndex);
  return deepFreeze(structuredClone(value));
}

function assertAttempts(value, sessionContextDigest) {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError("attempts must be a non-empty array.", { field: "attempts" });
  }

  const attemptIds = new Set();
  const childRunIds = new Set();
  let winnerCount = 0;
  const observedUsages = [];
  const observedCosts = [];
  const observedTimings = [];

  for (const [index, attempt] of value.entries()) {
    const { usage, cost } = assertAttempt(attempt, sessionContextDigest, index);
    if (attemptIds.has(attempt.attempt_id)) {
      throw usageError("attempts must not contain duplicate attempt_id values.", {
        field: "attempts.attempt_id",
      });
    }
    attemptIds.add(attempt.attempt_id);
    if (childRunIds.has(attempt.child_run_id)) {
      throw usageError("attempts must not contain duplicate child_run_id values.", {
        field: "attempts.child_run_id",
      });
    }
    childRunIds.add(attempt.child_run_id);
    if (attempt.winner) {
      winnerCount += 1;
    }
    if (usage !== null) {
      observedUsages.push(usage);
    }
    if (cost !== null) {
      observedCosts.push(cost);
    }
    observedTimings.push(attempt.timing);
  }

  if (winnerCount > 1) {
    throw usageError("adaptive sessions must not contain multiple winners.", {
      field: "attempts.winner",
    });
  }

  return { observedUsages, observedCosts, observedTimings, winnerCount };
}

function assertAggregateUsage(value, missingReason, observedUsages) {
  const aggregate = assertUsage(value, missingReason, "aggregate_usage");
  if (aggregate === null) {
    return;
  }

  for (const usageField of usageFields) {
    const componentSum = observedUsages.reduce(
      (total, usage) => total + usage[usageField],
      0,
    );
    if (aggregate[usageField] < componentSum) {
      throw usageError("aggregate usage cannot be below component sums.", {
        field: `aggregate_usage.${usageField}`,
      });
    }
  }
}

function assertAggregateCost(value, missingReason, observedCosts) {
  const aggregate = assertCost(value, missingReason, "aggregate_cost");
  if (aggregate === null) {
    return;
  }

  const componentSum = observedCosts.reduce(
    (total, cost) => total + cost.amount,
    0,
  );
  if (aggregate.amount < componentSum) {
    throw usageError("aggregate cost cannot be below component sums.", {
      field: "aggregate_cost.amount",
    });
  }
  for (const cost of observedCosts) {
    if (
      cost.currency !== aggregate.currency ||
      cost.pricing_source !== aggregate.pricing_source
    ) {
      throw usageError(
        "aggregate cost metadata must match observed component costs.",
        { field: "aggregate_cost" },
      );
    }
  }
}

function assertAggregateTiming(value, observedTimings) {
  assertTiming(value, "aggregate_timing");
  const componentWallMs = observedTimings.reduce(
    (total, timing) => total + timing.wall_ms,
    0,
  );
  if (value.wall_ms < componentWallMs) {
    throw usageError("aggregate timing cannot be below component sums.", {
      field: "aggregate_timing.wall_ms",
    });
  }
}

export function validateAdaptiveSession(value, options = {}) {
  validateContractBase(
    value,
    ADAPTIVE_SESSION_REQUIRED_FIELDS,
    "AdaptiveSession",
    options,
  );
  assertString(value.session_id, "session_id");
  assertSha256Hex(value.policy_sha256, "policy_sha256");
  assertSha256Hex(value.context_pack_sha256, "context_pack_sha256");
  if (value.terminal_reason !== undefined) {
    assertEnum(
      value.terminal_reason,
      "terminal_reason",
      ADAPTIVE_SESSION_TERMINAL_REASONS,
    );
  }
  const { observedUsages, observedCosts, observedTimings, winnerCount } = assertAttempts(
    value.attempts,
    value.context_pack_sha256,
  );
  if (
    value.terminal_reason !== undefined &&
    ((value.terminal_reason === "winner") !== (winnerCount === 1))
  ) {
    throw usageError("Adaptive session terminal reason contradicts its winner count.");
  }
  assertAggregateUsage(
    value.aggregate_usage,
    value.aggregate_usage_missing_reason,
    observedUsages,
  );
  assertAggregateTiming(value.aggregate_timing, observedTimings);
  assertAggregateCost(
    value.aggregate_cost,
    value.aggregate_cost_missing_reason,
    observedCosts,
  );
  return deepFreeze(structuredClone(value));
}

export const freezeAdaptiveSession = validateAdaptiveSession;
