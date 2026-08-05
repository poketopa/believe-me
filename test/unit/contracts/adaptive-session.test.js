import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_ATTEMPT_REQUIRED_FIELDS,
  ADAPTIVE_SESSION_REQUIRED_FIELDS,
  validateAdaptiveSession,
} from "../../../src/contracts/adaptive-session.js";
import { sha256CanonicalJSON } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const policy_sha256 = "a".repeat(64);
const context_pack_sha256 = "b".repeat(64);
const child_run_evidence_sha256 = "c".repeat(64);

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function usage(overrides = {}) {
  return {
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 50,
    reasoning_output_tokens: 20,
    total_tokens: 150,
    ...overrides,
  };
}

function timing(overrides = {}) {
  return {
    wall_ms: 1_000,
    executor_ms: 800,
    executor_ms_missing_reason: null,
    verification_ms: 100,
    verification_ms_missing_reason: null,
    orchestration_ms: 100,
    orchestration_ms_missing_reason: null,
    localization_ms: null,
    localization_ms_missing_reason: "not_applicable",
    routing_ms: null,
    routing_ms_missing_reason: "not_applicable",
    ...overrides,
  };
}

function cost(overrides = {}) {
  return {
    observation_status: "observed_billed",
    amount: 0.25,
    currency: "USD",
    pricing_source: "fixture-price-table",
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    attempt_index: 0,
    attempt_id: "attempt-1",
    child_run_id: "run-child-1",
    child_run_evidence_sha256,
    route_id: "initial-codex",
    route_reason: "initial",
    adapter_id: "codex-cli",
    model_id: "opaque-provider-model",
    reasoning_effort: "medium",
    context_pack_sha256,
    status: "completed",
    verification_status: "passed",
    winner: true,
    usage: usage(),
    usage_missing_reason: null,
    timing: timing(),
    cost: cost(),
    cost_missing_reason: null,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    schema_version,
    session_id: "adaptive-session-1",
    policy_sha256,
    context_pack_sha256,
    attempts: [attempt()],
    aggregate_usage: usage(),
    aggregate_usage_missing_reason: null,
    aggregate_timing: timing(),
    aggregate_cost: cost(),
    aggregate_cost_missing_reason: null,
    ...overrides,
  };
}

test("adaptive session field tables are explicit", () => {
  assert.deepEqual(ADAPTIVE_SESSION_REQUIRED_FIELDS, [
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
  assert.deepEqual(ADAPTIVE_ATTEMPT_REQUIRED_FIELDS, [
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
});

test("adaptive session accepts ordered attempts and freezes all telemetry", () => {
  const first = attempt({
    attempt_id: "attempt-1",
    child_run_id: "run-child-1",
    route_reason: "initial",
    status: "verification_failed",
    verification_status: "failed",
    winner: false,
    usage: usage({ total_tokens: 151 }),
    cost: cost({ amount: 0.20 }),
  });
  const second = attempt({
    attempt_index: 1,
    attempt_id: "attempt-2",
    child_run_id: "run-child-2",
    route_id: "repair-codex",
    route_reason: "verifier_failure",
    winner: true,
    usage: usage({ input_tokens: 80, output_tokens: 40, total_tokens: 120 }),
    cost: cost({ amount: 0.30 }),
  });

  const validated = validateAdaptiveSession(
    session({
      attempts: [first, second],
      aggregate_usage: usage({
        input_tokens: 180,
        cached_input_tokens: 20,
        output_tokens: 90,
        reasoning_output_tokens: 40,
        total_tokens: 271,
      }),
      aggregate_timing: timing({ wall_ms: 2_000 }),
      aggregate_cost: cost({ amount: 0.50 }),
    }),
  );

  assert.equal(validated.attempts[0].attempt_id, "attempt-1");
  assert.equal(validated.attempts[1].winner, true);
  assertFrozenTree(validated);
});

test("adaptive session rejects duplicate attempt and child run identifiers", () => {
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({ attempt_id: "same", child_run_id: "run-child-1" }),
            attempt({
              attempt_index: 1,
              attempt_id: "same",
              child_run_id: "run-child-2",
              winner: false,
            }),
          ],
          aggregate_timing: timing({ wall_ms: 2_000 }),
          aggregate_usage: usage({ input_tokens: 200, output_tokens: 100, total_tokens: 300 }),
          aggregate_cost: cost({ amount: 0.50 }),
        }),
      ),
    /duplicate attempt_id/,
  );
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({ attempt_id: "attempt-1", child_run_id: "same" }),
            attempt({
              attempt_index: 1,
              attempt_id: "attempt-2",
              child_run_id: "same",
              winner: false,
            }),
          ],
          aggregate_timing: timing({ wall_ms: 2_000 }),
          aggregate_usage: usage({ input_tokens: 200, output_tokens: 100, total_tokens: 300 }),
          aggregate_cost: cost({ amount: 0.50 }),
        }),
      ),
    /duplicate child_run_id/,
  );
});

test("adaptive session rejects unknown route reasons and invalid winners", () => {
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [attempt({ route_reason: "model_confidence" })],
        }),
      ),
    /unsupported value 'model_confidence'/,
  );
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({ attempt_id: "attempt-1", child_run_id: "run-child-1" }),
            attempt({
              attempt_index: 1,
              attempt_id: "attempt-2",
              child_run_id: "run-child-2",
            }),
          ],
          aggregate_timing: timing({ wall_ms: 2_000 }),
          aggregate_usage: usage({ input_tokens: 200, output_tokens: 100, total_tokens: 300 }),
          aggregate_cost: cost({ amount: 0.50 }),
        }),
      ),
    /multiple winners/,
  );
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({
              verification_status: "failed",
              status: "verification_failed",
              winner: true,
            }),
          ],
        }),
      ),
    /winner attempts must be verifier-passed/,
  );
});

test("adaptive session rejects contradictory terminal and verification states", () => {
  for (const [status, verification_status] of [
    ["completed", "not_run"],
    ["verification_failed", "not_run"],
    ["infra_error", "failed"],
    ["timeout", "passed"],
  ]) {
    assert.throws(
      () => validateAdaptiveSession(session({
        attempts: [attempt({
          status,
          verification_status,
          winner: false,
        })],
      })),
      /attempts require verification_status/,
    );
  }
});

test("adaptive session rejects aggregate usage or cost below component sums", () => {
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({ usage: usage({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }) }),
            attempt({
              attempt_index: 1,
              attempt_id: "attempt-2",
              child_run_id: "run-child-2",
              winner: false,
              usage: usage({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }),
            }),
          ],
          aggregate_timing: timing({ wall_ms: 2_000 }),
          aggregate_usage: usage({ input_tokens: 199, output_tokens: 100, total_tokens: 300 }),
          aggregate_cost: cost({ amount: 0.50 }),
        }),
      ),
    /aggregate usage cannot be below component sums/,
  );
  assert.throws(
    () =>
      validateAdaptiveSession(
        session({
          attempts: [
            attempt({ cost: cost({ amount: 0.25 }) }),
            attempt({
              attempt_index: 1,
              attempt_id: "attempt-2",
              child_run_id: "run-child-2",
              winner: false,
              cost: cost({ amount: 0.25 }),
            }),
          ],
          aggregate_timing: timing({ wall_ms: 2_000 }),
          aggregate_usage: usage({
            input_tokens: 200,
            cached_input_tokens: 20,
            output_tokens: 100,
            reasoning_output_tokens: 40,
            total_tokens: 300,
          }),
          aggregate_cost: cost({ amount: 0.49 }),
        }),
      ),
    /aggregate cost cannot be below component sums/,
  );
});

test("adaptive session binds child evidence and ordered attempt positions", () => {
  assert.throws(
    () => validateAdaptiveSession(session({
      attempts: [attempt({ child_run_evidence_sha256: "missing" })],
    })),
    /lowercase SHA-256/,
  );
  assert.throws(
    () => validateAdaptiveSession(session({
      attempts: [attempt({ attempt_index: 1 })],
    })),
    /attempt_index must match/,
  );
});

test("adaptive session rejects aggregate timing and cost metadata drift", () => {
  assert.throws(
    () => validateAdaptiveSession(session({
      aggregate_timing: timing({ wall_ms: 999 }),
    })),
    /aggregate timing cannot be below component sums/,
  );
  assert.throws(
    () => validateAdaptiveSession(session({
      aggregate_timing: timing({
        routing_ms: null,
        routing_ms_missing_reason: null,
      }),
    })),
    /routing_ms_missing_reason contains unsupported value/,
  );
  assert.throws(
    () => validateAdaptiveSession(session({
      aggregate_cost: cost({ currency: "KRW" }),
    })),
    /aggregate cost metadata must match/,
  );
});

test("adaptive session requires typed missing reasons for absent usage and cost", () => {
  const validated = validateAdaptiveSession(
    session({
      attempts: [
        attempt({
          usage: null,
          usage_missing_reason: "adapter_not_instrumented",
          cost: null,
          cost_missing_reason: "provider_not_reported",
        }),
      ],
      aggregate_usage: null,
      aggregate_usage_missing_reason: "adapter_not_instrumented",
      aggregate_cost: null,
      aggregate_cost_missing_reason: "provider_not_reported",
    }),
  );

  assert.equal(validated.attempts[0].usage, null);
  assert.equal(validated.attempts[0].usage_missing_reason, "adapter_not_instrumented");
  assert.equal(validated.aggregate_cost, null);
  assert.equal(validated.aggregate_cost_missing_reason, "provider_not_reported");

  assert.throws(
    () => validateAdaptiveSession(session({ aggregate_usage: null })),
    /aggregate_usage_missing_reason contains unsupported value/,
  );
  assert.throws(
    () => validateAdaptiveSession(session({
      aggregate_cost: null,
      aggregate_cost_missing_reason: "unknown",
    })),
    /unsupported value 'unknown'/,
  );
});

test("adaptive session rejects cost without full observation metadata", () => {
  for (const invalidCost of [
    { observation_status: "observed_billed", amount: 0.1, currency: "USD" },
    { observation_status: "observed_billed", amount: 0.1, pricing_source: "fixture" },
    { observation_status: "observed_billed", currency: "USD", pricing_source: "fixture" },
    { observation_status: "unknown", amount: 0.1, currency: "USD", pricing_source: "fixture" },
  ]) {
    assert.throws(
      () => validateAdaptiveSession(session({ aggregate_cost: invalidCost })),
      /missing required field|unsupported value/,
    );
  }
});

test("adaptive session canonical JSON digest is stable across key order", () => {
  const left = validateAdaptiveSession(session());
  const right = validateAdaptiveSession({
    aggregate_cost: cost(),
    aggregate_cost_missing_reason: null,
    aggregate_timing: timing(),
    aggregate_usage: usage(),
    aggregate_usage_missing_reason: null,
    attempts: [
      {
        attempt_index: 0,
        cost: cost(),
        cost_missing_reason: null,
        timing: timing(),
        usage: usage(),
        usage_missing_reason: null,
        winner: true,
        verification_status: "passed",
        status: "completed",
        context_pack_sha256,
        reasoning_effort: "medium",
        model_id: "opaque-provider-model",
        adapter_id: "codex-cli",
        route_reason: "initial",
        route_id: "initial-codex",
        child_run_id: "run-child-1",
        child_run_evidence_sha256,
        attempt_id: "attempt-1",
      },
    ],
    context_pack_sha256,
    policy_sha256,
    session_id: "adaptive-session-1",
    schema_version,
  });

  assert.equal(sha256CanonicalJSON(left), sha256CanonicalJSON(right));
});
