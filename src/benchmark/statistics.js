import { deepFreeze } from "../contracts/common.js";
import { usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { sha256Hex } from "../core/hash.js";
import {
  validateBenchmarkPairResult,
  validateComparisonV2PairResult,
} from "./contracts.js";
import {
  MUTATION_FAMILIES,
  MUTATION_OUTCOMES,
  validateMutationObservation,
  validateMutationRegistry,
} from "./mutations.js";

const arms = Object.freeze(["direct_codex", "harness"]);
const terminalStatuses = Object.freeze([
  "completed",
  "verification_failed",
  "safety_refusal",
  "infra_error",
  "timeout",
]);

function assertOptions(options) {
  if (options === undefined) {
    return {};
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("benchmark summary options must be an object.");
  }
  return options;
}

function safeIntegerOption(value, field, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError(`${field} must be a nonnegative safe integer.`, { field });
  }
  return value;
}

function rate(count, denominator) {
  return denominator === 0 ? null : count / denominator;
}

function successValue(armResult, pair) {
  const observation = armResult.observation;
  return pair.protocol_valid &&
    observation.terminal_status === "completed" && observation.verified_success
    ? 1
    : 0;
}

function booleanValue(armResult, field) {
  return armResult.observation[field] ? 1 : 0;
}

function logAdd(left, right) {
  if (left === -Infinity) return right;
  if (right === -Infinity) return left;
  const high = Math.max(left, right);
  return high + Math.log(Math.exp(left - high) + Math.exp(right - high));
}

function exactTwoSidedBinomialPValue(leftOnly, rightOnly) {
  const n = leftOnly + rightOnly;
  if (n === 0) {
    return 1;
  }
  const observedTail = Math.min(leftOnly, rightOnly);
  let logTerm = -n * Math.log(2);
  let logLowerTail = -Infinity;
  for (let index = 0; index <= observedTail; index += 1) {
    if (index > 0) {
      logTerm += Math.log(n - index + 1) - Math.log(index);
    }
    logLowerTail = logAdd(logLowerTail, logTerm);
  }
  return Math.min(1, Math.exp(logLowerTail + Math.log(2)));
}

function pairedBinaryMetric(pairs, reader) {
  let directSuccess = 0;
  let harnessSuccess = 0;
  let directOnly = 0;
  let harnessOnly = 0;
  let bothPositive = 0;
  let bothNegative = 0;

  for (const pair of pairs) {
    const direct = reader(pair.direct_codex, pair);
    const harness = reader(pair.harness, pair);
    directSuccess += direct;
    harnessSuccess += harness;
    if (direct === 1 && harness === 1) {
      bothPositive += 1;
    } else if (direct === 1 && harness === 0) {
      directOnly += 1;
    } else if (direct === 0 && harness === 1) {
      harnessOnly += 1;
    } else {
      bothNegative += 1;
    }
  }

  const count = pairs.length;
  return {
    direct_codex: {
      positive_count: directSuccess,
      rate: rate(directSuccess, count),
    },
    harness: {
      positive_count: harnessSuccess,
      rate: rate(harnessSuccess, count),
    },
    harness_minus_direct: rate(harnessSuccess - directSuccess, count),
    discordant: {
      direct_only: directOnly,
      harness_only: harnessOnly,
      both_positive: bothPositive,
      both_negative: bothNegative,
    },
  };
}

function armTerminalCounts(pairs) {
  const summary = {};
  for (const arm of arms) {
    const terminal_counts = Object.fromEntries(
      terminalStatuses.map((status) => [status, 0]),
    );
    for (const pair of pairs) {
      terminal_counts[pair[arm].observation.terminal_status] += 1;
    }
    summary[arm] = {
      terminal_counts,
      terminal_count: pairs.length,
      completed_count: terminal_counts.completed,
      infra_count: terminal_counts.infra_error,
      timeout_count: terminal_counts.timeout,
      noncompletion_count: pairs.length - terminal_counts.completed,
    };
  }
  return summary;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function telemetryValue(armResult, metric) {
  if (metric === "total_tokens") {
    const { usage, usage_missing_reason } = armResult.observation;
    return usage === null
      ? { value: null, reason: usage_missing_reason }
      : { value: usage.total_tokens, reason: null };
  }
  const timing = armResult.observation.timing;
  if (metric === "wall_ms") {
    return { value: timing.wall_ms, reason: null };
  }
  return {
    value: timing[metric],
    reason: timing[`${metric}_missing_reason`],
  };
}

function continuousMetric(pairs, metric) {
  const differences = [];
  const missing_by_arm = {
    direct_codex: 0,
    harness: 0,
  };
  const missing_reasons = {
    direct_codex: {},
    harness: {},
  };
  let missing_pair_count = 0;

  for (const pair of pairs) {
    const direct = telemetryValue(pair.direct_codex, metric);
    const harness = telemetryValue(pair.harness, metric);
    const directMissing = direct.value === null;
    const harnessMissing = harness.value === null;
    if (directMissing || harnessMissing) {
      missing_pair_count += 1;
      if (directMissing) {
        missing_by_arm.direct_codex += 1;
        incrementReason(missing_reasons.direct_codex, direct.reason);
      }
      if (harnessMissing) {
        missing_by_arm.harness += 1;
        incrementReason(missing_reasons.harness, harness.reason);
      }
      continue;
    }
    differences.push(harness.value - direct.value);
  }

  return {
    paired_complete_count: differences.length,
    missing_pair_count,
    missing_by_arm,
    missing_reasons,
    median_harness_minus_direct: median(differences),
  };
}

function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function taskClusters(pairs) {
  const clusters = new Map();
  for (const pair of pairs) {
    const key = pair.task.task_id;
    if (!clusters.has(key)) {
      clusters.set(key, []);
    }
    clusters.get(key).push(pair);
  }
  return Array.from(clusters.values());
}

function samplePairsFromClusters(clusters, random) {
  const sampled = [];
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[Math.floor(random() * clusters.length)];
    sampled.push(...cluster);
  }
  return sampled;
}

function percentile(values, probability) {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(probability * (sorted.length - 1))];
}

function ci95(values) {
  return {
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
  };
}

function bootstrapCi(pairs, replicates, seed, statistic) {
  if (pairs.length === 0 || replicates === 0) {
    return { lower: null, upper: null };
  }
  const clusters = taskClusters(pairs);
  const random = makePrng(seed);
  const values = [];
  for (let index = 0; index < replicates; index += 1) {
    const sampled = samplePairsFromClusters(clusters, random);
    const value = statistic(sampled);
    if (value !== null) {
      values.push(value);
    }
  }
  return ci95(values);
}

function binaryDifference(pairs, reader) {
  return pairedBinaryMetric(pairs, reader).harness_minus_direct;
}

function continuousDifference(pairs, metric) {
  return continuousMetric(pairs, metric).median_harness_minus_direct;
}

function evidenceLabel(pairs) {
  const frozen = pairs[0]?.experiment.analysis_cut_frozen ?? false;
  if (frozen) {
    return "frozen_comparative";
  }
  return pairs.length < 10 ? "pilot" : "exploratory";
}

function assertComparablePairs(pairs) {
  const experimentHashes = new Set(pairs.map((pair) =>
    sha256Hex(canonicalJSONBytes(pair.experiment))
  ));
  if (experimentHashes.size > 1) {
    throw usageError("benchmark summary cannot mix experiment definitions.");
  }
  const pairIds = new Set();
  for (const pair of pairs) {
    if (pairIds.has(pair.task.pair_id)) {
      throw usageError("benchmark summary contains a duplicate pair_id.", {
        pair_id: pair.task.pair_id,
      });
    }
    pairIds.add(pair.task.pair_id);
  }
}

export function summarizeBenchmarkPairs(pairRecords, options = undefined) {
  if (!Array.isArray(pairRecords)) {
    throw usageError("benchmark pairs must be an array.", { field: "pairs" });
  }
  const parsedOptions = assertOptions(options);
  const seed = safeIntegerOption(parsedOptions.seed, "seed", 1);
  const bootstrapReplicates = safeIntegerOption(
    parsedOptions.bootstrap_replicates,
    "bootstrap_replicates",
    10_000,
  );
  const pairs = pairRecords.map((pair) => validateBenchmarkPairResult(pair));
  assertComparablePairs(pairs);

  const success = pairedBinaryMetric(pairs, successValue);
  success.mcnemar = {
    direct_only: success.discordant.direct_only,
    harness_only: success.discordant.harness_only,
    p_value: exactTwoSidedBinomialPValue(
      success.discordant.direct_only,
      success.discordant.harness_only,
    ),
  };
  success.ci95_harness_minus_direct = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed,
    (sampled) => binaryDifference(sampled, successValue),
  );

  const safety = pairedBinaryMetric(
    pairs,
    (armResult) => booleanValue(armResult, "unsafe_or_out_of_scope"),
  );
  safety.ci95_harness_minus_direct = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed + 1,
    (sampled) =>
      binaryDifference(sampled, (armResult) =>
        booleanValue(armResult, "unsafe_or_out_of_scope"),
      ),
  );

  const sourceMutation = pairedBinaryMetric(
    pairs,
    (armResult) => booleanValue(armResult, "source_mutated_before_verification"),
  );
  sourceMutation.ci95_harness_minus_direct = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed + 2,
    (sampled) =>
      binaryDifference(sampled, (armResult) =>
        booleanValue(armResult, "source_mutated_before_verification"),
      ),
  );

  const totalTokens = continuousMetric(pairs, "total_tokens");
  totalTokens.ci95_median_harness_minus_direct = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed + 3,
    (sampled) => continuousDifference(sampled, "total_tokens"),
  );

  const wallMs = continuousMetric(pairs, "wall_ms");
  wallMs.ci95_median_harness_minus_direct = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed + 4,
    (sampled) => continuousDifference(sampled, "wall_ms"),
  );

  const componentMetrics = {};
  for (const [offset, metric] of [
    [5, "codex_child_ms"],
    [6, "verification_ms"],
    [7, "orchestration_ms"],
  ]) {
    const summary = continuousMetric(pairs, metric);
    summary.ci95_median_harness_minus_direct = bootstrapCi(
      pairs,
      bootstrapReplicates,
      seed + offset,
      (sampled) => continuousDifference(sampled, metric),
    );
    componentMetrics[metric] = summary;
  }

  const completedPairCount = pairs.filter((pair) =>
    arms.every((arm) => pair[arm].observation.terminal_status === "completed")
  ).length;
  const infrastructurePairCount = pairs.filter((pair) =>
    arms.some((arm) => ["infra_error", "timeout"].includes(
      pair[arm].observation.terminal_status,
    ))
  ).length;
  const protocolInvalidPairCount = pairs.filter(
    (pair) => !pair.protocol_valid,
  ).length;

  return deepFreeze({
    schema_version: { major: 1 },
    scheduled_pair_count: pairs.length,
    started_pair_count: pairs.length,
    terminal_pair_count: pairs.length,
    completed_pair_count: completedPairCount,
    infrastructure_pair_count: infrastructurePairCount,
    protocol_invalid_pair_count: protocolInvalidPairCount,
    evidence_label: evidenceLabel(pairs),
    bootstrap: {
      seed,
      replicates: bootstrapReplicates,
      cluster: "task_id",
    },
    arms: armTerminalCounts(pairs),
    end_to_end_success: success,
    safety: {
      unsafe_or_out_of_scope: safety,
    },
    source_mutation: {
      source_mutated_before_verification: sourceMutation,
    },
    continuous: {
      total_tokens: totalTokens,
      wall_ms: wallMs,
      ...componentMetrics,
    },
  });
}

function comparisonV2Success(armResult, pair) {
  return pair.protocol_valid &&
    armResult.observation.terminal_status === "completed" &&
    armResult.observation.verified_success
    ? 1
    : 0;
}

function comparisonV2PairedBinary(pairs, reader) {
  let controlPositive = 0;
  let treatmentPositive = 0;
  let controlOnly = 0;
  let treatmentOnly = 0;
  let bothPositive = 0;
  let bothNegative = 0;
  for (const pair of pairs) {
    const control = reader(pair.control, pair);
    const treatment = reader(pair.treatment, pair);
    controlPositive += control;
    treatmentPositive += treatment;
    if (control === 1 && treatment === 1) bothPositive += 1;
    else if (control === 1) controlOnly += 1;
    else if (treatment === 1) treatmentOnly += 1;
    else bothNegative += 1;
  }
  const count = pairs.length;
  return {
    control: {
      name: pairs[0]?.experiment.control.name ?? null,
      positive_count: controlPositive,
      rate: rate(controlPositive, count),
    },
    treatment: {
      name: pairs[0]?.experiment.treatment.name ?? null,
      positive_count: treatmentPositive,
      rate: rate(treatmentPositive, count),
    },
    treatment_minus_control: rate(treatmentPositive - controlPositive, count),
    discordant: {
      control_only: controlOnly,
      treatment_only: treatmentOnly,
      both_positive: bothPositive,
      both_negative: bothNegative,
    },
  };
}

function comparisonV2Telemetry(armResult, metric) {
  const observation = armResult.observation;
  if (metric === "total_tokens") {
    return observation.usage === null
      ? { value: null, reason: observation.usage_missing_reason }
      : { value: observation.usage.total_tokens, reason: null };
  }
  if (metric === "cost") {
    return observation.cost === null
      ? { value: null, reason: observation.cost_missing_reason, unit: null }
      : {
          value: observation.cost.amount,
          reason: null,
          unit: observation.cost.currency,
        };
  }
  return { value: observation[metric], reason: null };
}

function comparisonV2Continuous(pairs, metric) {
  const differences = [];
  const missing_by_role = { control: 0, treatment: 0 };
  const missing_reasons = { control: {}, treatment: {} };
  let missingPairCount = 0;
  for (const pair of pairs) {
    const control = comparisonV2Telemetry(pair.control, metric);
    const treatment = comparisonV2Telemetry(pair.treatment, metric);
    if (
      metric === "cost" &&
      control.value !== null &&
      treatment.value !== null &&
      control.unit !== treatment.unit
    ) {
      missingPairCount += 1;
      missing_by_role.control += 1;
      missing_by_role.treatment += 1;
      incrementReason(missing_reasons.control, "currency_mismatch");
      incrementReason(missing_reasons.treatment, "currency_mismatch");
      continue;
    }
    if (control.value === null || treatment.value === null) {
      missingPairCount += 1;
      if (control.value === null) {
        missing_by_role.control += 1;
        incrementReason(missing_reasons.control, control.reason);
      }
      if (treatment.value === null) {
        missing_by_role.treatment += 1;
        incrementReason(missing_reasons.treatment, treatment.reason);
      }
      continue;
    }
    differences.push(treatment.value - control.value);
  }
  return {
    paired_complete_count: differences.length,
    missing_pair_count: missingPairCount,
    missing_by_role,
    missing_reasons,
    median_treatment_minus_control: median(differences),
  };
}

function comparisonV2CostArm(pairs, role) {
  let totalObservedAmount = 0;
  let observedCount = 0;
  let missingCount = 0;
  let verifiedSuccessCount = 0;
  const missingReasons = {};
  const currencies = new Set();
  const pricingSources = new Set();
  const observationStatuses = {};
  for (const pair of pairs) {
    const arm = pair[role];
    verifiedSuccessCount += comparisonV2Success(arm, pair);
    if (arm.observation.cost === null) {
      missingCount += 1;
      incrementReason(missingReasons, arm.observation.cost_missing_reason);
      continue;
    }
    const cost = arm.observation.cost;
    totalObservedAmount += cost.amount;
    observedCount += 1;
    currencies.add(cost.currency);
    pricingSources.add(cost.pricing_source);
    incrementReason(observationStatuses, cost.observation_status);
  }
  return {
    observed_count: observedCount,
    missing_count: missingCount,
    missing_reasons: missingReasons,
    total_observed_amount: currencies.size <= 1 ? totalObservedAmount : null,
    currencies: [...currencies].toSorted(),
    pricing_sources: [...pricingSources].toSorted(),
    observation_status_counts: observationStatuses,
    verified_success_count: verifiedSuccessCount,
    cost_per_verified_success:
      currencies.size <= 1 && missingCount === 0 && verifiedSuccessCount > 0
        ? totalObservedAmount / verifiedSuccessCount
        : null,
  };
}

function assertComparableComparisonV2Pairs(pairs) {
  const experimentHashes = new Set(pairs.map((pair) =>
    sha256Hex(canonicalJSONBytes(pair.experiment))
  ));
  if (experimentHashes.size > 1) {
    throw usageError(
      "comparison-v2 summary cannot mix provider, policy, corpus, verifier, or schema definitions.",
    );
  }
  const pairIds = new Set();
  for (const pair of pairs) {
    if (pairIds.has(pair.task.pair_id)) {
      throw usageError("comparison-v2 summary contains a duplicate pair_id.", {
        pair_id: pair.task.pair_id,
      });
    }
    pairIds.add(pair.task.pair_id);
  }
}

export function summarizeComparisonV2Pairs(pairRecords, options = undefined) {
  if (!Array.isArray(pairRecords)) {
    throw usageError("comparison-v2 pairs must be an array.", { field: "pairs" });
  }
  const parsedOptions = assertOptions(options);
  const seed = safeIntegerOption(parsedOptions.seed, "seed", 1);
  const bootstrapReplicates = safeIntegerOption(
    parsedOptions.bootstrap_replicates,
    "bootstrap_replicates",
    10_000,
  );
  const pairs = pairRecords.map((pair) => validateComparisonV2PairResult(pair));
  assertComparableComparisonV2Pairs(pairs);

  const success = comparisonV2PairedBinary(pairs, comparisonV2Success);
  success.mcnemar = {
    control_only: success.discordant.control_only,
    treatment_only: success.discordant.treatment_only,
    p_value: exactTwoSidedBinomialPValue(
      success.discordant.control_only,
      success.discordant.treatment_only,
    ),
  };
  success.ci95_treatment_minus_control = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed,
    (sampled) =>
      comparisonV2PairedBinary(sampled, comparisonV2Success)
        .treatment_minus_control,
  );

  const unsafe = comparisonV2PairedBinary(
    pairs,
    (arm) => arm.observation.unsafe_or_out_of_scope ? 1 : 0,
  );
  unsafe.ci95_treatment_minus_control = bootstrapCi(
    pairs,
    bootstrapReplicates,
    seed + 1,
    (sampled) => comparisonV2PairedBinary(
      sampled,
      (arm) => arm.observation.unsafe_or_out_of_scope ? 1 : 0,
    ).treatment_minus_control,
  );

  const continuous = {};
  for (const [offset, metric] of [
    [2, "total_tokens"],
    [3, "wall_ms"],
    [4, "attempt_count"],
    [5, "cost"],
  ]) {
    const summary = comparisonV2Continuous(pairs, metric);
    summary.ci95_median_treatment_minus_control = bootstrapCi(
      pairs,
      bootstrapReplicates,
      seed + offset,
      (sampled) =>
        comparisonV2Continuous(sampled, metric)
          .median_treatment_minus_control,
    );
    continuous[metric] = summary;
  }

  return deepFreeze({
    schema_version: { major: 1 },
    comparison_version: 2,
    comparison_id: pairs[0]?.experiment.comparison_id ?? null,
    scheduled_pair_count: pairs.length,
    protocol_invalid_pair_count: pairs.filter((pair) => !pair.protocol_valid).length,
    evidence_label: evidenceLabel(pairs),
    bootstrap: {
      seed,
      replicates: bootstrapReplicates,
      cluster: "task_id",
    },
    end_to_end_success: success,
    safety: { unsafe_or_out_of_scope: unsafe },
    continuous,
    cost: {
      control: comparisonV2CostArm(pairs, "control"),
      treatment: comparisonV2CostArm(pairs, "treatment"),
    },
  });
}

export function summarizeMutationCalibration(registryValue, observationValues) {
  const registry = validateMutationRegistry(registryValue);
  if (!Array.isArray(observationValues)) {
    throw usageError("mutation observations must be an array.", {
      field: "observations",
    });
  }
  const observations = observationValues.map((value) =>
    validateMutationObservation(value));
  if (observations.length !== registry.mutations.length) {
    throw usageError("mutation calibration requires one observation per registered mutant.");
  }

  const definitionById = new Map(registry.mutations.map((mutation) => [
    mutation.mutation_id,
    mutation,
  ]));
  const observedIds = new Set();
  const outcomeCounts = Object.fromEntries(MUTATION_OUTCOMES.map((outcome) => [
    outcome,
    0,
  ]));
  const familyCounts = Object.fromEntries(MUTATION_FAMILIES.map((family) => [
    family,
    Object.fromEntries(MUTATION_OUTCOMES.map((outcome) => [outcome, 0])),
  ]));

  for (const observation of observations) {
    const definition = definitionById.get(observation.mutation_id);
    if (
      definition === undefined ||
      observedIds.has(observation.mutation_id) ||
      observation.corpus_id !== registry.corpus_id ||
      observation.registry_sha256 !== registry.registry_sha256 ||
      observation.mutation_sha256 !== definition.mutation_sha256 ||
      observation.task_id !== definition.task_id ||
      observation.fixture_kind !== definition.fixture_kind ||
      observation.target_path !== definition.target_path ||
      observation.baseline_sha256 !== definition.baseline_sha256 ||
      (observation.outcome !== "invalid" &&
        observation.target_sha256 !== definition.mutated_sha256) ||
      observation.expected_verifier_outcome !==
        definition.expected_verifier_outcome
    ) {
      throw usageError(
        "mutation observation does not match its registered deterministic mutant.",
        { mutation_id: observation.mutation_id },
      );
    }
    observedIds.add(observation.mutation_id);
    outcomeCounts[observation.outcome] += 1;
    familyCounts[definition.family][observation.outcome] += 1;
  }

  const expectedRejectCount = registry.mutations.filter((mutation) =>
    mutation.expected_verifier_outcome === "reject").length;
  const scoredCount = outcomeCounts.killed + outcomeCounts.survived;
  const tasks = [...new Set(registry.mutations.map((mutation) => mutation.task_id))]
    .toSorted();
  const fixtureKinds = [...new Set(registry.mutations.map((mutation) =>
    mutation.fixture_kind))].toSorted();
  const verifierCommands = [...new Set(registry.mutations.map((mutation) =>
    sha256Hex(canonicalJSONBytes({
      adapter_id: mutation.verifier.adapter_id,
      command: mutation.verifier.command,
      args: mutation.verifier.args,
    }))))].toSorted();

  return deepFreeze({
    schema_version: { major: 1 },
    corpus_id: registry.corpus_id,
    registry_sha256: registry.registry_sha256,
    registered_mutation_count: registry.mutations.length,
    observed_mutation_count: observations.length,
    expected_reject_count: expectedRejectCount,
    scored_mutation_count: scoredCount,
    outcome_counts: outcomeCounts,
    mutation_score: scoredCount === 0
      ? null
      : outcomeCounts.killed / scoredCount,
    false_accept_count: outcomeCounts.survived,
    false_accept_rate: expectedRejectCount === 0
      ? null
      : outcomeCounts.survived / expectedRejectCount,
    family_outcome_counts: familyCounts,
    corpus_diversity: {
      task_count: tasks.length,
      task_ids: tasks,
      fixture_kind_count: fixtureKinds.length,
      fixture_kinds: fixtureKinds,
      verifier_command_count: verifierCommands.length,
      verifier_command_sha256: verifierCommands,
      claim_scope: "descriptive_corpus_only",
    },
  });
}
