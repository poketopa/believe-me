import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBenchmarkArmResult,
  validateBenchmarkExperiment,
  validateBenchmarkPairResult,
  validateBenchmarkTask,
} from "../../../src/benchmark/contracts.js";

const schema_version = { major: 1 };
const baseline = "a".repeat(64);
const artifact = "b".repeat(64);

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function experiment(overrides = {}) {
  return {
    schema_version,
    experiment_id: "exp-1",
    seed: 123,
    order_algorithm: "sha256-task-alternating-v1",
    analysis_cut_frozen: false,
    provider: {
      adapter_id: "codex-cli",
      model: "gpt-5.5",
      reasoning_effort: "medium",
      timeout_ms: 600000,
    },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    schema_version,
    experiment_id: "exp-1",
    pair_id: "pair-1",
    task_id: "task-1",
    repeat_index: 0,
    project_ref: "fixture://task-1",
    task: "Implement the behavior.",
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
      cached_input_tokens: 2,
      output_tokens: 5,
      reasoning_output_tokens: 1,
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
      verifier_log: null,
      provider_configuration_sha256: artifact,
      observed_provider_configuration_sha256: artifact,
    },
    failure_phase: null,
    ...overrides,
  };
}

function arm(armName, overrides = {}) {
  return {
    schema_version,
    experiment: experiment(),
    task: task(),
    arm: armName,
    baseline_sha256: baseline,
    observation: observation(),
    ...overrides,
  };
}

function pair(overrides = {}) {
  return {
    schema_version,
    experiment: experiment(),
    task: task(),
    baseline_sha256: baseline,
    order: "direct_first",
    provider_configuration_equivalent: true,
    protocol_valid: true,
    protocol_invalid_reasons: [],
    direct_codex: arm("direct_codex"),
    harness: arm("harness"),
    ...overrides,
  };
}

test("benchmark validators freeze runner records and preserve terminal outcomes", () => {
  const exp = validateBenchmarkExperiment(experiment());
  const taskRecord = validateBenchmarkTask(task());
  const unsafeArm = validateBenchmarkArmResult(
    arm("harness", {
      observation: observation({
        terminal_status: "safety_refusal",
        verification_status: "failed",
        verified_success: false,
        unsafe_or_out_of_scope: true,
        usage: null,
        usage_missing_reason: "safety refusal before usage",
        timing: {
          wall_ms: 250,
          codex_child_ms: null,
          codex_child_ms_missing_reason: "not started",
          verification_ms: 40,
          verification_ms_missing_reason: null,
          orchestration_ms: null,
          orchestration_ms_missing_reason: "not measured",
        },
        changed_paths: [],
        failure_phase: "safety",
      }),
    }),
  );

  assert.equal(exp.provider.timeout_ms, 600000);
  assert.equal(taskRecord.allowed_paths[0], "src/example.js");
  assert.equal(unsafeArm.observation.terminal_status, "safety_refusal");
  assert.equal(unsafeArm.observation.verification_status, "failed");
  assert.equal(unsafeArm.observation.unsafe_or_out_of_scope, true);
  assertFrozenTree(unsafeArm);
});

test("benchmark contracts reject missing fields, inconsistent usage, and bad bindings", () => {
  assert.throws(
    () => validateBenchmarkExperiment({ schema_version }),
    /missing required field 'experiment_id'/,
  );
  assert.throws(
    () => validateBenchmarkTask(task({ allowed_paths: [] })),
    /allowed_paths must be an array/,
  );
  assert.throws(
    () => validateBenchmarkTask(task({ allowed_paths: ["../escape"] })),
    /normalized relative POSIX paths/,
  );
  assert.throws(
    () =>
      validateBenchmarkArmResult(
        arm("direct_codex", {
          observation: observation({
            usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
              total_tokens: 20,
            },
          }),
        }),
      ),
    /usage is internally inconsistent/,
  );
  assert.throws(
    () => validateBenchmarkArmResult(arm("harness", {
      observation: observation({
        terminal_status: "completed",
        verified_success: false,
      }),
    })),
    /completed benchmark observations must be verified successes/,
  );
  assert.throws(
    () =>
      validateBenchmarkPairResult(
        pair({
          task: task({ experiment_id: "other-exp" }),
        }),
      ),
    /task experiment_id must match experiment_id/,
  );
  assert.throws(
    () =>
      validateBenchmarkPairResult(
        pair({
          harness: arm("direct_codex"),
        }),
      ),
    /pair arms must be exactly/,
  );
  assert.throws(
    () => validateBenchmarkPairResult(pair({
      provider_configuration_equivalent: false,
    })),
    /does not match arm evidence/,
  );
  assert.doesNotThrow(() => validateBenchmarkPairResult(pair({
    provider_configuration_equivalent: false,
    protocol_valid: false,
    protocol_invalid_reasons: ["provider_configuration_unobserved"],
    direct_codex: arm("direct_codex", {
      observation: observation({
        artifact_hashes: {
          transcript: artifact,
          verifier_log: null,
          provider_configuration_sha256: artifact,
          observed_provider_configuration_sha256: null,
        },
      }),
    }),
  })));
  assert.throws(() => validateBenchmarkPairResult(pair({
    provider_configuration_equivalent: false,
    protocol_valid: false,
    protocol_invalid_reasons: ["registered_protocol_deviation"],
    harness: arm("harness", {
      observation: observation({
        artifact_hashes: {
          transcript: artifact,
          verifier_log: null,
          provider_configuration_sha256: artifact,
          observed_provider_configuration_sha256: "c".repeat(64),
        },
      }),
    }),
  })), /must include 'provider_configuration_mismatch'/);
});

test("pair validator binds identical experiment, task, baseline, and terminal arms", () => {
  const validated = validateBenchmarkPairResult(pair());
  assert.equal(validated.direct_codex.observation.terminal_status, "completed");
  assert.equal(validated.harness.observation.verification_status, "passed");
  assertFrozenTree(validated);

  assert.throws(
    () =>
      validateBenchmarkPairResult(
        pair({
          direct_codex: arm("direct_codex", {
            task: task({ pair_id: "pair-2" }),
          }),
        }),
      ),
    /pair task must match both arm results/,
  );
  assert.throws(
    () =>
      validateBenchmarkPairResult(
        pair({
          direct_codex: arm("direct_codex", {
            baseline_sha256: "c".repeat(64),
          }),
        }),
      ),
    /arm baseline_sha256 must match task baseline_sha256/,
  );
});
