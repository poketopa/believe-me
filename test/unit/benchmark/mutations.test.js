import assert from "node:assert/strict";
import test from "node:test";
import {
  MUTATION_EXPECTED_VERIFIER_OUTCOMES,
  MUTATION_FAMILIES,
  MUTATION_OUTCOMES,
  validateMutationDefinition,
  validateMutationObservation,
  validateMutationRegistry,
} from "../../../src/benchmark/mutations.js";
import { sha256CanonicalJSON, sha256Hex } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const baseline = "a".repeat(64);
const target = "b".repeat(64);
const result = "c".repeat(64);

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function contentBytes(id = "mutation") {
  return Buffer.from(`export const value = "${id}";\n`, "utf8");
}

function definition(overrides = {}) {
  const bytes = contentBytes(overrides.mutation_id ?? "mutation-001");
  return {
    schema_version,
    mutation_id: "mutation-001",
    task_id: "task-1",
    fixture_kind: "node",
    target_path: "src/example.js",
    baseline_sha256: baseline,
    mutated_content_base64: bytes.toString("base64"),
    mutated_sha256: sha256Hex(bytes),
    family: "condition_inversion",
    expected_verifier_outcome: "reject",
    verifier: {
      adapter_id: "node-test",
      command: "npm",
      args: ["test", "--", "mutation-001"],
      timeout_ms: 30_000,
      max_output_bytes: 1024,
    },
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    schema_version,
    corpus_id: "calibration-pr5",
    mutations: [
      definition({ mutation_id: "mutation-001" }),
      definition({
        mutation_id: "mutation-002",
        family: "boundary_alteration",
      }),
    ],
    ...overrides,
  };
}

function observation(overrides = {}) {
  const validated = validateMutationDefinition(definition());
  return {
    schema_version,
    corpus_id: "calibration-pr5",
    registry_sha256: "d".repeat(64),
    mutation_id: validated.mutation_id,
    mutation_sha256: validated.mutation_sha256,
    task_id: validated.task_id,
    fixture_kind: validated.fixture_kind,
    target_path: validated.target_path,
    baseline_sha256: validated.baseline_sha256,
    target_sha256: target,
    expected_verifier_outcome: validated.expected_verifier_outcome,
    outcome: "killed",
    verifier_status: "reject",
    verifier_result_sha256: result,
    verifier_failure_code: "assertion_failed",
    ...overrides,
  };
}

test("mutation constants enumerate calibration families and outcomes", () => {
  assert.deepEqual(MUTATION_FAMILIES, [
    "condition_inversion",
    "boundary_alteration",
    "guard_or_exception_removal",
    "incorrect_return",
  ]);
  assert.deepEqual(MUTATION_EXPECTED_VERIFIER_OUTCOMES, [
    "reject",
    "accept",
    "undetermined",
  ]);
  assert.deepEqual(MUTATION_OUTCOMES, [
    "killed",
    "survived",
    "invalid",
    "equivalent_or_undetermined",
    "infrastructure",
  ]);
  assert.equal(Object.isFrozen(MUTATION_FAMILIES), true);
  assert.equal(Object.isFrozen(MUTATION_OUTCOMES), true);
});

test("mutation definition validates, freezes, and exposes canonical mutation digest", () => {
  const unordered = {
    ...definition(),
    verifier: {
      args: ["test", "--", "mutation-001"],
      command: "npm",
      adapter_id: "node-test",
      max_output_bytes: 1024,
      timeout_ms: 30_000,
    },
  };
  const validated = validateMutationDefinition(unordered);
  const withoutDigest = structuredClone(validated);
  delete withoutDigest.mutation_sha256;

  assert.equal(validated.mutation_sha256, sha256CanonicalJSON(withoutDigest));
  assert.equal(
    validated.mutation_sha256,
    validateMutationDefinition(structuredClone(validated)).mutation_sha256,
  );
  assertFrozenTree(validated);
});

test("mutation definitions admit every required mutation family", () => {
  for (const family of MUTATION_FAMILIES) {
    const validated = validateMutationDefinition(
      definition({
        mutation_id: `mutation-${family}`,
        family,
      }),
    );

    assert.equal(validated.family, family);
  }
});

test("mutation registry validates non-empty sorted unique records and registry digest", () => {
  const validated = validateMutationRegistry(registry());
  const withoutDigest = structuredClone(validated);
  delete withoutDigest.registry_sha256;

  assert.equal(validated.corpus_id, "calibration-pr5");
  assert.equal(validated.mutations.length, 2);
  assert.equal(validated.registry_sha256, sha256CanonicalJSON(withoutDigest));
  assertFrozenTree(validated);
});

test("mutation registry rejects duplicate and unsorted mutation ids", () => {
  assert.throws(
    () =>
      validateMutationRegistry(
        registry({
          mutations: [
            definition({ mutation_id: "mutation-001" }),
            definition({ mutation_id: "mutation-001" }),
          ],
        }),
      ),
    /mutation_id values must be unique/,
  );
  assert.throws(
    () =>
      validateMutationRegistry(
        registry({
          mutations: [
            definition({ mutation_id: "mutation-002" }),
            definition({ mutation_id: "mutation-001" }),
          ],
        }),
      ),
    /sorted by mutation_id/,
  );
  assert.throws(
    () => validateMutationRegistry(registry({ mutations: [] })),
    /non-empty array/,
  );
});

test("mutation definition rejects hash, base64, and target path tampering", () => {
  assert.throws(
    () =>
      validateMutationDefinition(
        definition({ mutated_sha256: "f".repeat(64) }),
      ),
    /mutated_sha256 must match mutated_content_base64/,
  );
  const bytes = contentBytes();
  assert.throws(
    () => validateMutationDefinition(definition({
      baseline_sha256: sha256Hex(bytes),
      mutated_content_base64: bytes.toString("base64"),
      mutated_sha256: sha256Hex(bytes),
    })),
    /must differ from baseline_sha256/u,
  );
  assert.throws(
    () =>
      validateMutationDefinition(
        definition({ mutated_content_base64: "YQ" }),
      ),
    /canonical non-empty base64/,
  );
  assert.throws(
    () => validateMutationDefinition(definition({ target_path: "../escape.js" })),
    /normalized safe relative POSIX path/,
  );
  assert.throws(
    () =>
      validateMutationDefinition(
        definition({ mutation_sha256: "e".repeat(64) }),
      ),
    /mutation_sha256 does not match canonical/,
  );
});

test("mutation definitions bind positive verifier execution limits", () => {
  for (const [field, value] of [
    ["timeout_ms", 0],
    ["max_output_bytes", -1],
  ]) {
    assert.throws(
      () => validateMutationDefinition(definition({
        verifier: { ...definition().verifier, [field]: value },
      })),
      new RegExp(`verifier\\.${field} must be a positive safe integer`),
    );
  }
});

test("mutation observations classify killed verifier rejections", () => {
  const validated = validateMutationObservation(observation());

  assert.equal(validated.outcome, "killed");
  assert.equal(validated.verifier_status, "reject");
  assert.equal(validated.verifier_failure_code, "assertion_failed");
  assertFrozenTree(validated);
});

test("mutation observations classify survived verifier accepts", () => {
  const validated = validateMutationObservation(
    observation({
      outcome: "survived",
      verifier_status: "accept",
      verifier_failure_code: null,
    }),
  );

  assert.equal(validated.outcome, "survived");
  assert.equal(validated.verifier_status, "accept");
});

test("mutation observations classify invalid mutations", () => {
  const validated = validateMutationObservation(
    observation({
      outcome: "invalid",
      verifier_status: "undetermined",
      verifier_result_sha256: null,
      verifier_failure_code: "invalid_mutation",
    }),
  );

  assert.equal(validated.outcome, "invalid");
  assert.equal(validated.verifier_failure_code, "invalid_mutation");
});

test("mutation observations classify equivalent or verifier-undetermined cases", () => {
  const validated = validateMutationObservation(
    observation({
      expected_verifier_outcome: "accept",
      outcome: "equivalent_or_undetermined",
      verifier_status: "accept",
      verifier_failure_code: null,
    }),
  );

  assert.equal(validated.outcome, "equivalent_or_undetermined");
  assert.equal(validated.expected_verifier_outcome, "accept");
});

test("mutation observations classify infrastructure failures", () => {
  const validated = validateMutationObservation(
    observation({
      outcome: "infrastructure",
      verifier_status: "undetermined",
      verifier_result_sha256: null,
      verifier_failure_code: "verifier_timeout",
    }),
  );

  assert.equal(validated.outcome, "infrastructure");
  assert.equal(validated.verifier_status, "undetermined");
});

test("mutation observations reject contradictory killed and survived semantics", () => {
  assert.throws(
    () =>
      validateMutationObservation(
        observation({
          outcome: "killed",
          verifier_status: "accept",
          verifier_failure_code: null,
        }),
      ),
    /outcome contradicts expected verifier semantics/,
  );
  assert.throws(
    () =>
      validateMutationObservation(
        observation({
          outcome: "survived",
          verifier_status: "reject",
        }),
      ),
    /outcome contradicts expected verifier semantics/,
  );
  assert.throws(
    () =>
      validateMutationObservation(
        observation({
          outcome: "killed",
          target_sha256: baseline,
        }),
      ),
    /changed target hash/,
  );
});
