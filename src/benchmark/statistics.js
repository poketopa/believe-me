import { deepFreeze } from "../contracts/common.js";
import { usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { sha256Hex } from "../core/hash.js";
import { validateBenchmarkPairResult } from "./contracts.js";

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
