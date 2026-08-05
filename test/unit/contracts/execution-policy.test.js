import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_ROUTE_REASONS,
  EXECUTION_POLICY_REQUIRED_FIELDS,
  EXECUTION_POLICY_ROUTE_REQUIRED_FIELDS,
  validateExecutionPolicy,
} from "../../../src/contracts/execution-policy.js";
import { sha256CanonicalJSON } from "../../../src/core/hash.js";

const schema_version = { major: 1 };

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function policy(overrides = {}) {
  return {
    schema_version,
    policy_id: "adaptive-policy-fixture",
    attempt_budget: 2,
    token_budget: 100_000,
    wall_budget_ms: 600_000,
    routes: [
      {
        route_id: "initial-codex",
        reason: "initial",
        adapter_id: "codex-cli",
        model_id: "opaque-provider-model",
        reasoning_effort: "medium",
        timeout_ms: 300_000,
      },
      {
        route_id: "repair-codex",
        reason: "verifier_failure",
        adapter_id: "codex-cli",
        model_id: "another-opaque-model",
        reasoning_effort: "high",
        timeout_ms: 300_000,
      },
    ],
    ...overrides,
  };
}

test("execution policy field tables and route reasons are explicit", () => {
  assert.deepEqual(EXECUTION_POLICY_REQUIRED_FIELDS, [
    "schema_version",
    "policy_id",
    "attempt_budget",
    "token_budget",
    "wall_budget_ms",
    "routes",
  ]);
  assert.deepEqual(EXECUTION_POLICY_ROUTE_REQUIRED_FIELDS, [
    "route_id",
    "reason",
    "adapter_id",
    "model_id",
    "reasoning_effort",
    "timeout_ms",
  ]);
  assert.deepEqual(ADAPTIVE_ROUTE_REASONS, [
    "initial",
    "verifier_failure",
    "transient_infra_retry",
  ]);
});

test("execution policy accepts provider-neutral opaque route identifiers and freezes", () => {
  const validated = validateExecutionPolicy(policy());

  assert.equal(validated.routes[0].model_id, "opaque-provider-model");
  assertFrozenTree(validated);
});

test("execution policy rejects zero or negative budgets", () => {
  for (const [field, value] of [
    ["attempt_budget", 0],
    ["token_budget", -1],
    ["wall_budget_ms", 0],
  ]) {
    assert.throws(
      () => validateExecutionPolicy(policy({ [field]: value })),
      /positive safe integer/,
      field,
    );
  }
  assert.throws(
    () =>
      validateExecutionPolicy(
        policy({
          routes: [
            {
              ...policy().routes[0],
              timeout_ms: 0,
            },
          ],
        }),
      ),
    /positive safe integer/,
  );
});

test("execution policy rejects duplicate routes and unknown route reasons", () => {
  assert.throws(
    () =>
      validateExecutionPolicy(
        policy({
          routes: [
            policy().routes[0],
            { ...policy().routes[1], route_id: policy().routes[0].route_id },
          ],
        }),
      ),
    /duplicate route_id/,
  );
  assert.throws(
    () =>
      validateExecutionPolicy(
        policy({
          routes: [{ ...policy().routes[0], reason: "model_confidence" }],
        }),
      ),
    /unsupported value 'model_confidence'/,
  );
});

test("execution policy canonical JSON digest is stable across key order", () => {
  const left = validateExecutionPolicy(policy());
  const right = validateExecutionPolicy({
    routes: policy().routes.map((route) => ({
      timeout_ms: route.timeout_ms,
      reasoning_effort: route.reasoning_effort,
      model_id: route.model_id,
      adapter_id: route.adapter_id,
      reason: route.reason,
      route_id: route.route_id,
    })),
    wall_budget_ms: 600_000,
    token_budget: 100_000,
    attempt_budget: 2,
    policy_id: "adaptive-policy-fixture",
    schema_version,
  });

  assert.equal(sha256CanonicalJSON(left), sha256CanonicalJSON(right));
});

test("execution policy admits only bounded provider-neutral route constraints", () => {
  const value = policy();
  value.routes[0].match = {
    max_context_bytes: 4096,
    max_allowed_paths: 3,
    verifier_kinds: ["command-verifier"],
    risk_tiers: ["low", "medium"],
  };
  assert.deepEqual(validateExecutionPolicy(value).routes[0].match, value.routes[0].match);

  for (const match of [
    {},
    { min_price: 1 },
    { max_context_bytes: 0 },
    { risk_tiers: ["unknown"] },
  ]) {
    const invalid = policy();
    invalid.routes[0].match = match;
    assert.throws(() => validateExecutionPolicy(invalid), /route\.match|risk_tiers/u);
  }
});
