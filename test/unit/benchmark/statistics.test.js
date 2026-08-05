import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBenchmarkPairs } from "../../../src/benchmark/statistics.js";

const schema_version = { major: 1 };
const baseline = "a".repeat(64);
const artifact = "b".repeat(64);

function experiment(overrides = {}) {
  return {
    schema_version,
    experiment_id: "exp-1",
    seed: 77,
    order_algorithm: "sha256-task-alternating-v1",
    analysis_cut_frozen: false,
    provider: {
      adapter_id: "codex-cli",
      model: null,
      reasoning_effort: null,
      timeout_ms: 600000,
    },
    ...overrides,
  };
}

function task(index, overrides = {}) {
  return {
    schema_version,
    experiment_id: "exp-1",
    pair_id: `pair-${index}`,
    task_id: `task-${index}`,
    repeat_index: 0,
    project_ref: `fixture://task-${index}`,
    task: `Task ${index}`,
    allowed_paths: ["src/example.js"],
    baseline_sha256: baseline,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    terminal_status: "completed",
    verification_status: "passed",
    verified_success: true,
    unsafe_or_out_of_scope: false,
    source_mutated_before_verification: false,
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 15,
    },
    usage_missing_reason: null,
    timing: {
      wall_ms: 1000,
      codex_child_ms: 900,
      codex_child_ms_missing_reason: null,
      verification_ms: 80,
      verification_ms_missing_reason: null,
      orchestration_ms: 20,
      orchestration_ms_missing_reason: null,
    },
    changed_paths: ["src/example.js"],
    artifact_hashes: {
      transcript: artifact,
      provider_configuration_sha256: artifact,
      observed_provider_configuration_sha256: artifact,
    },
    failure_phase: null,
    ...overrides,
  };
}

function arm(index, armName, observationOverrides = {}) {
  return {
    schema_version,
    experiment: experiment(),
    task: task(index),
    arm: armName,
    baseline_sha256: baseline,
    observation: observation(observationOverrides),
  };
}

function pair(index, directObservation = {}, harnessObservation = {}, overrides = {}) {
  const taskRecord = task(index);
  const experimentRecord = experiment(overrides.experiment ?? {});
  return {
    schema_version,
    experiment: experimentRecord,
    task: taskRecord,
    baseline_sha256: baseline,
    order: index % 2 === 0 ? "direct_first" : "harness_first",
    provider_configuration_equivalent: true,
    protocol_valid: true,
    protocol_invalid_reasons: [],
    direct_codex: {
      ...arm(index, "direct_codex", directObservation),
      experiment: experimentRecord,
      task: taskRecord,
    },
    harness: {
      ...arm(index, "harness", harnessObservation),
      experiment: experimentRecord,
      task: taskRecord,
    },
  };
}

function failedObservation(extra = {}) {
  return {
    terminal_status: "verification_failed",
    verification_status: "failed",
    verified_success: false,
    failure_phase: "verification",
    ...extra,
  };
}

test("all-negative and infra rows are reported without suppression", () => {
  const summary = summarizeBenchmarkPairs(
    [
      pair(
        1,
        failedObservation({ terminal_status: "infra_error", failure_phase: "infra" }),
        failedObservation(),
      ),
      pair(2, failedObservation(), failedObservation()),
    ],
    { seed: 5, bootstrap_replicates: 20 },
  );

  assert.equal(summary.scheduled_pair_count, 2);
  assert.equal(summary.evidence_label, "pilot");
  assert.equal(summary.arms.direct_codex.terminal_counts.infra_error, 1);
  assert.equal(summary.arms.harness.terminal_counts.verification_failed, 2);
  assert.equal(summary.end_to_end_success.direct_codex.positive_count, 0);
  assert.equal(summary.end_to_end_success.harness.positive_count, 0);
  assert.equal(summary.end_to_end_success.harness_minus_direct, 0);
  assert.equal(summary.end_to_end_success.mcnemar.p_value, 1);
  assert.equal(Object.isFrozen(summary), true);
});

test("known McNemar discordant counts produce exact two-sided binomial p-value", () => {
  const summary = summarizeBenchmarkPairs(
    [
      pair(1, {}, failedObservation()),
      pair(2, failedObservation(), {}),
      pair(3, failedObservation(), {}),
      pair(4, failedObservation(), {}),
    ],
    { seed: 1, bootstrap_replicates: 50 },
  );

  assert.equal(summary.end_to_end_success.discordant.direct_only, 1);
  assert.equal(summary.end_to_end_success.discordant.harness_only, 3);
  assert.equal(summary.end_to_end_success.mcnemar.p_value, 0.625);
  assert.equal(summary.end_to_end_success.harness_minus_direct, 0.5);
});

test("task-cluster bootstrap is deterministic for the same seed", () => {
  const records = [
    pair(1, {}, failedObservation()),
    pair(2, failedObservation(), {}),
    pair(3, {}, {}),
    pair(4, failedObservation(), failedObservation()),
  ];

  const first = summarizeBenchmarkPairs(records, {
    seed: 42,
    bootstrap_replicates: 200,
  });
  const second = summarizeBenchmarkPairs(records, {
    seed: 42,
    bootstrap_replicates: 200,
  });
  const differentSeed = summarizeBenchmarkPairs(records, {
    seed: 43,
    bootstrap_replicates: 200,
  });

  assert.deepEqual(
    first.end_to_end_success.ci95_harness_minus_direct,
    second.end_to_end_success.ci95_harness_minus_direct,
  );
  assert.notDeepEqual(
    first.end_to_end_success.ci95_harness_minus_direct,
    differentSeed.end_to_end_success.ci95_harness_minus_direct,
  );
});

test("missing total token telemetry is counted and not imputed", () => {
  const summary = summarizeBenchmarkPairs(
    [
      pair(1, {}, { usage: null, usage_missing_reason: "missing usage event" }),
      pair(
        2,
        {
          usage: null,
          usage_missing_reason: "timeout before usage",
        },
        {},
      ),
      pair(
        3,
        {
          usage: {
            input_tokens: 8,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
            total_tokens: 10,
          },
        },
        {
          usage: {
            input_tokens: 14,
            cached_input_tokens: 0,
            output_tokens: 6,
            reasoning_output_tokens: 0,
            total_tokens: 20,
          },
        },
      ),
    ],
    { seed: 9, bootstrap_replicates: 100 },
  );

  assert.equal(summary.continuous.total_tokens.paired_complete_count, 1);
  assert.equal(summary.continuous.total_tokens.missing_pair_count, 2);
  assert.deepEqual(summary.continuous.total_tokens.missing_by_arm, {
    direct_codex: 1,
    harness: 1,
  });
  assert.deepEqual(summary.continuous.total_tokens.missing_reasons, {
    direct_codex: { "timeout before usage": 1 },
    harness: { "missing usage event": 1 },
  });
  assert.equal(summary.continuous.total_tokens.median_harness_minus_direct, 10);
  assert.equal(summary.continuous.wall_ms.paired_complete_count, 3);
  assert.equal(summary.continuous.codex_child_ms.paired_complete_count, 3);
  assert.equal(summary.continuous.verification_ms.paired_complete_count, 3);
  assert.equal(summary.continuous.orchestration_ms.paired_complete_count, 3);
});

test("component timing missingness remains explicit", () => {
  const summary = summarizeBenchmarkPairs([
    pair(1, {}, {
      timing: {
        wall_ms: 1000,
        codex_child_ms: 800,
        codex_child_ms_missing_reason: null,
        verification_ms: null,
        verification_ms_missing_reason: "verification not run",
        orchestration_ms: null,
        orchestration_ms_missing_reason: "component timing incomplete",
      },
    }),
  ], { seed: 3, bootstrap_replicates: 20 });

  assert.equal(summary.continuous.verification_ms.paired_complete_count, 0);
  assert.equal(summary.continuous.verification_ms.missing_pair_count, 1);
  assert.deepEqual(summary.continuous.verification_ms.missing_reasons.harness, {
    "verification not run": 1,
  });
});

test("summary refuses duplicate pairs and mixed experiment definitions", () => {
  assert.throws(
    () => summarizeBenchmarkPairs([pair(1), pair(1)]),
    /duplicate pair_id/,
  );
  assert.throws(
    () => summarizeBenchmarkPairs([
      pair(1),
      pair(2, {}, {}, { experiment: { seed: 99 } }),
    ]),
    /cannot mix experiment definitions/,
  );
});

test("provider configuration drift stays in the ITT denominator as protocol invalid", () => {
  const drifted = pair(1);
  drifted.provider_configuration_equivalent = false;
  drifted.protocol_valid = false;
  drifted.protocol_invalid_reasons = ["provider_configuration_mismatch"];
  drifted.harness.observation.artifact_hashes.observed_provider_configuration_sha256 =
    "c".repeat(64);
  const summary = summarizeBenchmarkPairs([drifted], {
    seed: 4,
    bootstrap_replicates: 20,
  });

  assert.equal(summary.scheduled_pair_count, 1);
  assert.equal(summary.protocol_invalid_pair_count, 1);
  assert.equal(summary.end_to_end_success.direct_codex.positive_count, 0);
  assert.equal(summary.end_to_end_success.harness.positive_count, 0);
});

test("evidence labels distinguish exploratory and frozen comparative cuts", () => {
  const exploratory = Array.from({ length: 10 }, (_, index) => pair(index + 1));
  assert.equal(
    summarizeBenchmarkPairs(exploratory, {
      seed: 1,
      bootstrap_replicates: 10,
    }).evidence_label,
    "exploratory",
  );

  assert.equal(
    summarizeBenchmarkPairs(
      [pair(1, {}, {}, { experiment: { analysis_cut_frozen: true } })],
      { seed: 1, bootstrap_replicates: 10 },
    ).evidence_label,
    "frozen_comparative",
  );
});
