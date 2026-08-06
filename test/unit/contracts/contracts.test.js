import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_RECEIPT_REQUIRED_FIELDS,
  LIFECYCLE_STATES,
  RUN_SPEC_REQUIRED_FIELDS,
  RUN_STATE_IMMUTABLE_FIELDS,
  RUN_STATE_REQUIRED_FIELDS,
  SKILL_MANIFEST_REQUIRED_FIELDS,
  WORKFLOW_PLAN_REQUIRED_FIELDS,
  validateEvidenceReceipt,
  validateRunSpec,
  validateRunState,
  validateSkillManifest,
  validateWorkflowPlan,
} from "../../../src/index.js";

const schema_version = { major: 1 };
const hash = "a".repeat(64);

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

test("contract field tables match the PRD required fields", () => {
  assert.deepEqual(SKILL_MANIFEST_REQUIRED_FIELDS, [
    "schema_version",
    "manifest_id",
    "name",
    "policy_id",
    "executor_kinds",
    "input_schema_ref",
    "policy_rules",
  ]);
  assert.deepEqual(WORKFLOW_PLAN_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "manifest_sha256",
    "source_snapshot_sha256",
    "executor_kind",
    "steps",
    "expected_result",
  ]);
  assert.deepEqual(RUN_SPEC_REQUIRED_FIELDS, [
    "schema_version",
    "project_path",
    "state_dir",
    "skill_manifest_path",
    "input_path",
    "executor_kind",
  ]);
  assert.deepEqual(RUN_STATE_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "lifecycle_state",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
    "executor_kind",
    "artifact_root",
  ]);
  assert.deepEqual(EVIDENCE_RECEIPT_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
    "verification_sha256",
    "result_sha256",
    "approval_method",
    "issued_at",
  ]);
});

test("contracts round-trip schema version and freeze persisted fields", () => {
  const contracts = [
    validateSkillManifest({
      schema_version,
      manifest_id: "roomescape",
      name: "Roomescape policy",
      policy_id: "roomescape-cancel-booking-penalty",
      executor_kinds: ["deterministic", "codex"],
      input_schema_ref: "fixture.json",
      policy_rules: { rule: "deadline" },
      verifier: {
        schema_version,
        adapter_id: "command-verifier",
        command: "node",
        args: ["--test"],
        timeout_ms: 30_000,
        max_output_bytes: 1_048_576,
      },
    }),
    validateWorkflowPlan({
      schema_version,
      run_id: "run-1",
      manifest_sha256: hash,
      source_snapshot_sha256: hash,
      executor_kind: "deterministic",
      steps: [{ id: "verify" }],
      expected_result: { status: "verified" },
    }),
    validateRunSpec({
      schema_version,
      project_path: "/project",
      state_dir: "/project/.harness",
      skill_manifest_path: "/project/skill.json",
      input_path: "/project/input.json",
      executor_kind: "deterministic",
    }),
    validateRunState({
      schema_version,
      run_id: "run-1",
      lifecycle_state: "draft",
      manifest_sha256: hash,
      workflow_plan_sha256: hash,
      source_snapshot_sha256: hash,
      executor_kind: "deterministic",
      artifact_root: "/project/.harness/runs/run-1",
    }),
    validateEvidenceReceipt({
      schema_version,
      run_id: "run-1",
      manifest_sha256: hash,
      workflow_plan_sha256: hash,
      source_snapshot_sha256: hash,
      verification_sha256: hash,
      result_sha256: hash,
      approval_method: "receipt_sha256",
      issued_at: "2026-08-05T00:00:00.000Z",
    }),
  ];

  for (const contract of contracts) {
    assert.deepEqual(contract.schema_version, schema_version);
    assertFrozenTree(contract);
  }
  assert.equal(contracts[0].verifier.adapter_id, "command-verifier");
});

test("required fields, enums, and schema major are validated", () => {
  assert.throws(
    () => validateSkillManifest({ schema_version }),
    /missing required field 'manifest_id'/,
  );
  assert.throws(
    () =>
      validateRunSpec({
        schema_version,
        project_path: "/project",
        state_dir: "/state",
        skill_manifest_path: "/skill.json",
        input_path: "/input.json",
        executor_kind: "shell",
      }),
    /unsupported value 'shell'/,
  );
  assert.throws(
    () =>
      validateRunState({
        schema_version,
        run_id: "run-1",
        lifecycle_state: "done",
        manifest_sha256: hash,
        workflow_plan_sha256: hash,
        source_snapshot_sha256: hash,
        executor_kind: "deterministic",
        artifact_root: "/artifacts",
      }),
    /unsupported value 'done'/,
  );
  assert.throws(
    () => validateWorkflowPlan({ schema_version: { major: 2 } }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  assert.throws(
    () => validateWorkflowPlan({ schema_version: 1 }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  assert.throws(
    () =>
      validateWorkflowPlan({
        schema_version,
        run_id: "run-1",
        manifest_sha256: "not-a-digest",
        source_snapshot_sha256: hash,
        executor_kind: "deterministic",
        steps: [],
        expected_result: {},
      }),
    /lowercase SHA-256 hex digest/,
  );
});

test("receipt rejects self-hash and run-state immutable fields are explicit", () => {
  assert.deepEqual(RUN_STATE_IMMUTABLE_FIELDS, [
    "run_id",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
    "executor_kind",
    "artifact_root",
    "hermetic_boundary_sha256",
  ]);
  assert.deepEqual(LIFECYCLE_STATES, [
    "draft",
    "planned",
    "executing",
    "verified",
    "receipted",
    "approved",
    "applied",
    "rolled_back",
    "rejected",
  ]);

  assert.throws(
    () =>
      validateEvidenceReceipt({
        schema_version,
        run_id: "run-1",
        manifest_sha256: hash,
        workflow_plan_sha256: hash,
        source_snapshot_sha256: hash,
        verification_sha256: hash,
        result_sha256: hash,
        approval_method: "receipt_sha256",
        issued_at: "2026-08-05T00:00:00.000Z",
        receipt_sha256: hash,
      }),
    /must not carry a self-hash/,
  );
});
