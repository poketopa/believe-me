import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateComparisonV2ArmResult,
  validateComparisonV2Experiment,
  validateComparisonV2PairResult,
  validateComparisonV2Task,
} from "../../../src/benchmark/contracts.js";
import {
  buildComparisonV2Ledger,
  parseComparisonV2Ledger,
  readComparisonV2Ledger,
  writeComparisonV2Ledger,
} from "../../../src/benchmark/ledger.js";
import { summarizeComparisonV2Pairs } from "../../../src/benchmark/statistics.js";
import { sha256CanonicalJSON } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const hashes = Object.freeze({
  source: "a".repeat(64),
  task: "b".repeat(64),
  controlProvider: "c".repeat(64),
  treatmentProvider: "d".repeat(64),
  controlPolicy: "e".repeat(64),
  treatmentPolicy: "f".repeat(64),
  controlConfiguration: "1".repeat(64),
  treatmentConfiguration: "2".repeat(64),
  verifier: "3".repeat(64),
  corpus: "4".repeat(64),
  artifact: "5".repeat(64),
});

function experiment(overrides = {}) {
  return {
    schema_version,
    comparison_version: 2,
    comparison_id: "comparison-1",
    seed: 17,
    order_algorithm: "sha256-arm-alternating-v2",
    analysis_cut_frozen: false,
    verifier_sha256: hashes.verifier,
    corpus_sha256: hashes.corpus,
    control: {
      name: "one-shot",
      provider_sha256: hashes.controlProvider,
      policy_sha256: hashes.controlPolicy,
      configuration_sha256: hashes.controlConfiguration,
    },
    treatment: {
      name: "telemetry-only",
      provider_sha256: hashes.treatmentProvider,
      policy_sha256: hashes.treatmentPolicy,
      configuration_sha256: hashes.treatmentConfiguration,
    },
    ...overrides,
  };
}

function task(index = 1, overrides = {}) {
  return {
    schema_version,
    comparison_version: 2,
    comparison_id: "comparison-1",
    pair_id: `pair-${index}`,
    task_id: `task-${index}`,
    repeat_index: 0,
    project_ref: `fixture://task-${index}`,
    source_sha256: hashes.source,
    task_sha256: hashes.task,
    ...overrides,
  };
}

function usage(total = 15) {
  return {
    input_tokens: total - 5,
    cached_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 1,
    total_tokens: total,
  };
}

function observation(overrides = {}) {
  return {
    terminal_status: "completed",
    verified_success: true,
    unsafe_or_out_of_scope: false,
    attempt_count: 1,
    usage: usage(),
    usage_missing_reason: null,
    wall_ms: 1000,
    cost: {
      amount: 0.25,
      currency: "USD",
      pricing_source: "provider-bill",
      observation_status: "observed_billed",
    },
    cost_missing_reason: null,
    artifact_hashes: {
      adaptive_session_sha256: hashes.artifact,
    },
    ...overrides,
  };
}

function arm(role, exp, taskRecord, overrides = {}) {
  const descriptor = exp[role];
  return {
    schema_version,
    comparison_version: 2,
    experiment: exp,
    task: taskRecord,
    role,
    name: descriptor.name,
    provider_sha256: descriptor.provider_sha256,
    policy_sha256: descriptor.policy_sha256,
    configuration_sha256: descriptor.configuration_sha256,
    observation: observation(),
    ...overrides,
  };
}

function pair(index = 1, overrides = {}) {
  const exp = overrides.experiment ?? experiment();
  const taskRecord = overrides.task ?? task(index);
  return {
    schema_version,
    comparison_version: 2,
    experiment: exp,
    task: taskRecord,
    order: index % 2 === 0
      ? [exp.treatment.name, exp.control.name]
      : [exp.control.name, exp.treatment.name],
    protocol_valid: true,
    protocol_invalid_reasons: [],
    control: arm("control", exp, taskRecord),
    treatment: arm("treatment", exp, taskRecord),
    ...overrides,
  };
}

function failedObservation(overrides = {}) {
  return observation({
    terminal_status: "verification_failed",
    verified_success: false,
    ...overrides,
  });
}

test("comparison-v2 contracts validate, freeze, bind, and digest canonical records", () => {
  const exp = validateComparisonV2Experiment(experiment());
  const taskRecord = validateComparisonV2Task(task());
  const armRecord = validateComparisonV2ArmResult(
    arm("control", experiment(), task()),
  );
  const pairRecord = validateComparisonV2PairResult(pair());

  assert.equal(Object.isFrozen(exp.control), true);
  assert.equal(Object.isFrozen(taskRecord), true);
  assert.equal(Object.isFrozen(armRecord.observation), true);
  assert.equal(Object.isFrozen(pairRecord.treatment), true);
  assert.equal(
    sha256CanonicalJSON(pairRecord),
    sha256CanonicalJSON(validateComparisonV2PairResult(structuredClone(pairRecord))),
  );
});

test("comparison-v2 rejects bad bindings, cost metadata, missingness, and protocol", () => {
  assert.throws(
    () => validateComparisonV2Experiment(experiment({ comparison_version: 1 })),
    /comparison_version must be exactly 2/,
  );
  assert.throws(
    () => validateComparisonV2Experiment(experiment({
      treatment: { ...experiment().treatment, name: "one-shot" },
    })),
    /arm names must be distinct/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, { order: ["one-shot"] })),
    /order must contain each arm name exactly once/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      treatment: {
        ...pair().treatment,
        configuration_sha256: hashes.controlConfiguration,
      },
    })),
    /configuration_sha256 must match/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      protocol_valid: false,
      protocol_invalid_reasons: [],
    })),
    /protocol_valid must match/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      control: {
        ...pair().control,
        observation: observation({
          cost: { amount: 1, currency: "USD" },
        }),
      },
    })),
    /missing required field 'pricing_source'/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      control: {
        ...pair().control,
        observation: observation({
          usage: null,
          usage_missing_reason: "unknown",
        }),
      },
    })),
    /unsupported value 'unknown'/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      control: {
        ...pair().control,
        observation: observation({ attempt_count: 0 }),
      },
    })),
    /completed comparison observations require an attempt/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      control: {
        ...pair().control,
        observation: failedObservation({
          attempt_count: 0,
          usage: null,
          usage_missing_reason: "execution_not_started",
          cost: null,
          cost_missing_reason: "execution_not_started",
        }),
      },
    })),
    /verification_failed comparison observations require an attempt/,
  );
  assert.throws(
    () => validateComparisonV2PairResult(pair(1, {
      control: {
        ...pair().control,
        observation: failedObservation({
          attempt_count: 1,
          usage: null,
          usage_missing_reason: "execution_not_started",
          cost: null,
          cost_missing_reason: "execution_not_started",
        }),
      },
    })),
    /execution_not_started missing reasons require zero attempts/,
  );
});

test("comparison-v2 summary retains failures and reports nullable cost honestly", () => {
  const first = pair(1);
  first.treatment.observation = failedObservation({
    attempt_count: 2,
    usage: usage(25),
    wall_ms: 1800,
    cost: {
      amount: 0.5,
      currency: "USD",
      pricing_source: "provider-bill",
      observation_status: "observed_billed",
    },
  });
  const second = pair(2);
  second.control.observation = observation({
    usage: usage(10),
    cost: {
      amount: 0.1,
      currency: "USD",
      pricing_source: "provider-bill",
      observation_status: "observed_billed",
    },
  });
  second.treatment.observation = observation({
    usage: null,
    usage_missing_reason: "provider_not_reported",
    cost: null,
    cost_missing_reason: "provider_not_reported",
  });

  const summary = summarizeComparisonV2Pairs([first, second], {
    seed: 9,
    bootstrap_replicates: 50,
  });
  assert.equal(summary.scheduled_pair_count, 2);
  assert.equal(summary.end_to_end_success.control.positive_count, 2);
  assert.equal(summary.end_to_end_success.treatment.positive_count, 1);
  assert.equal(summary.end_to_end_success.treatment_minus_control, -0.5);
  assert.equal(summary.continuous.total_tokens.missing_pair_count, 1);
  assert.deepEqual(summary.continuous.total_tokens.missing_reasons.treatment, {
    provider_not_reported: 1,
  });
  assert.equal(summary.cost.control.total_observed_amount, 0.35);
  assert.equal(summary.cost.control.cost_per_verified_success, 0.175);
  assert.equal(summary.cost.treatment.missing_count, 1);
  assert.equal(summary.cost.treatment.cost_per_verified_success, null);
});

test("comparison-v2 summary rejects duplicate pairs and mixed definitions", () => {
  assert.throws(
    () => summarizeComparisonV2Pairs([pair(1), pair(1)]),
    /duplicate pair_id/,
  );
  assert.throws(
    () => summarizeComparisonV2Pairs([
      pair(1),
      pair(2, { experiment: experiment({ corpus_sha256: "6".repeat(64) }) }),
    ]),
    /cannot mix provider, policy, corpus, verifier, or schema definitions/,
  );
});

test("comparison-v2 never combines or subtracts unlike currencies", () => {
  const first = pair(1);
  first.treatment.observation = observation({
    cost: {
      amount: 100,
      currency: "KRW",
      pricing_source: "provider-bill",
      observation_status: "observed_billed",
    },
  });
  const second = pair(2);
  second.control.observation = observation({
    cost: {
      amount: 100,
      currency: "KRW",
      pricing_source: "provider-bill",
      observation_status: "observed_billed",
    },
  });

  const summary = summarizeComparisonV2Pairs([first, second], {
    seed: 1,
    bootstrap_replicates: 10,
  });
  assert.equal(summary.continuous.cost.missing_pair_count, 2);
  assert.deepEqual(summary.continuous.cost.missing_reasons.control, {
    currency_mismatch: 2,
  });
  assert.equal(summary.cost.control.total_observed_amount, null);
  assert.equal(summary.cost.control.cost_per_verified_success, null);
  assert.equal(summary.cost.treatment.total_observed_amount, null);
});

test("comparison-v2 ledger round-trips canonical JSONL and digest sidecar", async () => {
  const pairs = [pair(2), pair(1)];
  const built = buildComparisonV2Ledger({
    experiment: experiment(),
    pairs,
    summaryOptions: { seed: 4, bootstrap_replicates: 20 },
  });
  const parsed = parseComparisonV2Ledger(built.bytes);
  assert.equal(parsed.sha256, built.sha256);
  assert.deepEqual(parsed.pairs.map((entry) => entry.task.pair_id), ["pair-1", "pair-2"]);

  const directory = await mkdtemp(join(tmpdir(), "believeme-comparison-v2-"));
  const path = join(directory, "comparison.jsonl");
  try {
    const written = await writeComparisonV2Ledger({
      path,
      experiment: experiment(),
      pairs,
      summaryOptions: { seed: 4, bootstrap_replicates: 20 },
    });
    const read = await readComparisonV2Ledger(path);
    assert.equal(read.sha256, written.sha256);
    assert.equal(read.summary.comparison_version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
