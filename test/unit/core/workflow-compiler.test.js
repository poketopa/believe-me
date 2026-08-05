import assert from "node:assert/strict";
import test from "node:test";
import { validateRunSpec } from "../../../src/contracts/run-spec.js";
import { validateSkillManifest } from "../../../src/contracts/skill-manifest.js";
import { compileWorkflowPlan } from "../../../src/core/workflow-compiler.js";
import { sha256CanonicalJSONLine } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const sourceSnapshot = {
  schema_version,
  entries: [],
  sha256: "b".repeat(64),
};
const inputSha256 = "c".repeat(64);
const runSpecSha256 = "d".repeat(64);

function manifest(overrides = {}) {
  return validateSkillManifest({
    schema_version,
    manifest_id: "roomescape",
    name: "Roomescape policy",
    policy_id: "roomescape-cancel-booking-penalty",
    executor_kinds: ["deterministic"],
    input_schema_ref: "fixture.json",
    policy_rules: { rule: "deadline" },
    ...overrides,
  });
}

function runSpec(overrides = {}) {
  return validateRunSpec({
    schema_version,
    project_path: "/project",
    state_dir: "/project/.harness",
    skill_manifest_path: "/project/skill.json",
    input_path: "/project/input.json",
    executor_kind: "deterministic",
    ...overrides,
  });
}

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

test("compileWorkflowPlan emits immutable deterministic workflow plan", () => {
  const skillManifest = manifest();
  const plan = compileWorkflowPlan({
    skillManifest,
    runSpec: runSpec(),
    sourceSnapshot,
    inputSha256,
    runSpecSha256,
    runId: "run-1",
  });

  assertFrozenTree(plan);
  assert.equal(plan.run_id, "run-1");
  assert.equal(plan.executor_kind, "deterministic");
  assert.equal(plan.manifest_sha256, sha256CanonicalJSONLine(skillManifest));
  assert.equal(plan.source_snapshot_sha256, sourceSnapshot.sha256);
  assert.deepEqual(plan.steps, [
    { id: "snapshot", order: 1 },
    { id: "execute", order: 2 },
    { id: "verify", order: 3 },
    { id: "receipt", order: 4 },
  ]);
  assert.deepEqual(plan.expected_result, {
    input_sha256: inputSha256,
    status: "completed",
    min_changes: 1,
    run_spec_sha256: runSpecSha256,
  });
});

test("compileWorkflowPlan rejects executor kinds not admitted by manifest", () => {
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest({ executor_kinds: ["codex"] }),
        runSpec: runSpec({ executor_kind: "deterministic" }),
        sourceSnapshot,
        inputSha256,
        runSpecSha256,
        runId: "run-1",
      }),
    /not admitted/,
  );
});

test("compileWorkflowPlan validates explicit run id and source snapshot digest", () => {
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot,
        inputSha256,
        runSpecSha256,
        runId: "",
      }),
    /runId must be a non-empty string/,
  );
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot: { ...sourceSnapshot, sha256: "not-a-digest" },
        inputSha256,
        runSpecSha256,
        runId: "run-1",
      }),
    /sourceSnapshot.sha256 must be a lowercase SHA-256 hex digest/,
  );
});

test("compileWorkflowPlan requires and validates input and run spec digests", () => {
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot,
        runSpecSha256,
        runId: "run-1",
      }),
    /inputSha256 must be a non-empty string/,
  );
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot,
        inputSha256,
        runId: "run-1",
      }),
    /runSpecSha256 must be a non-empty string/,
  );
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot,
        inputSha256: "not-a-digest",
        runSpecSha256,
        runId: "run-1",
      }),
    /inputSha256 must be a lowercase SHA-256 hex digest/,
  );
  assert.throws(
    () =>
      compileWorkflowPlan({
        skillManifest: manifest(),
        runSpec: runSpec(),
        sourceSnapshot,
        inputSha256,
        runSpecSha256: "not-a-digest",
        runId: "run-1",
      }),
    /runSpecSha256 must be a lowercase SHA-256 hex digest/,
  );
});
