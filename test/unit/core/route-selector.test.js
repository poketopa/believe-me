import assert from "node:assert/strict";
import test from "node:test";
import {
  createOneAttemptRoutedExecutor,
  deriveRouteFeatures,
  resolveExecutionRoute,
  selectExecutionRoute,
  validateExecutionPolicy,
  validateRouteFeatures,
} from "../../../src/index.js";

function policy() {
  return validateExecutionPolicy({
    schema_version: { major: 1 },
    policy_id: "one-attempt-policy",
    attempt_budget: 1,
    token_budget: 10_000,
    wall_budget_ms: 60_000,
    routes: [
      {
        route_id: "bounded-route",
        reason: "initial",
        adapter_id: "adapter-a",
        model_id: "model-small",
        reasoning_effort: "low",
        timeout_ms: 10_000,
        match: {
          max_context_bytes: 100,
          max_allowed_paths: 2,
          verifier_kinds: ["command-verifier"],
          risk_tiers: ["low", "medium"],
        },
      },
      {
        route_id: "default-route",
        reason: "initial",
        adapter_id: "adapter-b",
        model_id: "model-large",
        reasoning_effort: "high",
        timeout_ms: 20_000,
      },
      {
        route_id: "future-repair",
        reason: "verifier_failure",
        adapter_id: "adapter-b",
        model_id: "model-large",
        reasoning_effort: "high",
        timeout_ms: 20_000,
      },
    ],
  });
}

function features(overrides = {}) {
  return {
    context_bytes: 100,
    allowed_path_count: 2,
    verifier_kind: "command-verifier",
    risk_tier: "medium",
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    "adapter-a": {
      executor_kind: "codex",
      model_ids: ["model-small"],
      reasoning_efforts: ["low"],
      create_executor: () => async () => ({ status: "completed" }),
    },
    "adapter-b": {
      executor_kind: "codex",
      model_ids: ["model-large"],
      reasoning_efforts: ["high"],
      create_executor: () => async () => ({ status: "completed" }),
    },
    ...overrides,
  };
}

test("fixed policy and features select the same frozen route and reason codes", () => {
  const first = selectExecutionRoute({ policy: policy(), features: features() });
  const second = selectExecutionRoute({ policy: policy(), features: features() });
  assert.deepEqual(first, second);
  assert.equal(first.route_id, "bounded-route");
  assert.deepEqual(first.reason_codes, [
    "allowed_path_count",
    "context_bytes",
    "risk_tier",
    "verifier_kind",
  ]);
  assert.equal(Object.isFrozen(first), true);
});

test("route features derive only from bounded observable inputs", () => {
  const derived = deriveRouteFeatures({
    allowedPaths: ["src/app.js", "test/app.test.js"],
    verifierKind: "command-verifier",
    riskTier: "low",
  });
  assert.deepEqual(derived, {
    context_bytes: 0,
    allowed_path_count: 2,
    verifier_kind: "command-verifier",
    risk_tier: "low",
  });
  assert.throws(
    () => deriveRouteFeatures({
      allowedPaths: ["src/app.js", "src/app.js"],
      verifierKind: "command-verifier",
      riskTier: "low",
    }),
    /unique/u,
  );
});

test("documented boundary values select constrained then default route", () => {
  assert.equal(selectExecutionRoute({
    policy: policy(),
    features: features({ context_bytes: 100, allowed_path_count: 2 }),
  }).route_id, "bounded-route");
  const over = selectExecutionRoute({
    policy: policy(),
    features: features({ context_bytes: 101 }),
  });
  assert.equal(over.route_id, "default-route");
  assert.deepEqual(over.reason_codes, ["default"]);
});

test("selector rejects unmatched policy and authority-bearing feature fields", () => {
  const unmatched = structuredClone(policy());
  unmatched.routes.splice(1);
  assert.throws(
    () => selectExecutionRoute({
      policy: unmatched,
      features: features({ context_bytes: 101 }),
    }),
    /no matching initial route/u,
  );
  assert.throws(
    () => validateRouteFeatures({ ...features(), project_path: "/other" }),
    /unsupported fields/u,
  );
});

test("unknown adapter model and reasoning aliases fail before execution", () => {
  const selection = selectExecutionRoute({ policy: policy(), features: features() });
  assert.throws(
    () => resolveExecutionRoute(selection, {}),
    /adapter is unavailable/u,
  );
  assert.throws(
    () => resolveExecutionRoute(selection, registry({
      "adapter-a": { ...registry()["adapter-a"], model_ids: ["other"] },
    })),
    /model alias is unavailable/u,
  );
  assert.throws(
    () => resolveExecutionRoute(selection, registry({
      "adapter-a": { ...registry()["adapter-a"], reasoning_efforts: ["other"] },
    })),
    /reasoning alias is unavailable/u,
  );
});

test("one-attempt routed executor records selection and refuses a second call", async () => {
  let calls = 0;
  const selection = selectExecutionRoute({ policy: policy(), features: features() });
  const routed = createOneAttemptRoutedExecutor({
    selection,
    adapterRegistry: registry({
      "adapter-a": {
        ...registry()["adapter-a"],
        create_executor(observed) {
          assert.deepEqual(observed, selection);
          return async () => {
            calls += 1;
            return { status: "completed", value: 1 };
          };
        },
      },
    }),
  });
  const result = await routed.executor({});
  assert.equal(calls, 1);
  assert.deepEqual(result.route_selection, selection);
  await assert.rejects(() => routed.executor({}), /cannot be invoked twice/u);
  assert.equal(calls, 1);
});
