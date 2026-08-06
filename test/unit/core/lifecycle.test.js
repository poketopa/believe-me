import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_TRANSITIONS,
  advanceRunState,
  canTransitionLifecycle,
} from "../../../src/index.js";

const hash = "a".repeat(64);

function state(overrides = {}) {
  return {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "draft",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
    artifact_root: "/artifacts/run-1",
    ...overrides,
  };
}

test("lifecycle transition table is explicit and exact", () => {
  assert.deepEqual(LIFECYCLE_TRANSITIONS, {
    draft: ["planned", "rejected"],
    planned: ["executing", "rejected"],
    executing: ["verified", "rejected", "rolled_back"],
    verified: ["receipted", "rejected"],
    receipted: ["approved", "rejected"],
    approved: ["applied", "rolled_back", "rejected"],
    applied: [],
    rolled_back: [],
    rejected: [],
  });

  assert.equal(canTransitionLifecycle("draft", "planned"), true);
  assert.equal(canTransitionLifecycle("draft", "verified"), false);
  assert.equal(canTransitionLifecycle("applied", "rejected"), false);
});

test("advanceRunState enforces valid transitions and immutable fields", () => {
  const planned = advanceRunState(state(), { lifecycle_state: "planned" });
  assert.equal(planned.lifecycle_state, "planned");

  assert.throws(
    () => advanceRunState(planned, { lifecycle_state: "receipted" }),
    /Invalid lifecycle transition/,
  );
  assert.throws(
    () =>
      advanceRunState(planned, {
        lifecycle_state: "executing",
        manifest_sha256: "b".repeat(64),
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.throws(
    () => advanceRunState(planned, {
      lifecycle_state: "executing",
      hermetic_boundary_sha256: hash,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("receipt and approval guarded states require frozen hashes before advancing", () => {
  const verified = state({ lifecycle_state: "verified" });

  assert.throws(
    () => advanceRunState(verified, { lifecycle_state: "receipted" }),
    /without 'receipt_sha256'/,
  );

  const receipted = advanceRunState(verified, {
    lifecycle_state: "receipted",
    receipt_sha256: hash,
  });

  assert.throws(
    () => advanceRunState(receipted, { lifecycle_state: "approved" }),
    /without 'approval_sha256'/,
  );

  const approved = advanceRunState(receipted, {
    lifecycle_state: "approved",
    approval_sha256: hash,
  });
  assert.equal(approved.lifecycle_state, "approved");
});

test("receipt and approval hashes cannot change after they exist", () => {
  const receipted = state({
    lifecycle_state: "receipted",
    receipt_sha256: hash,
  });

  assert.throws(
    () =>
      advanceRunState(receipted, {
        lifecycle_state: "approved",
        receipt_sha256: "b".repeat(64),
        approval_sha256: hash,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  const approved = state({
    lifecycle_state: "approved",
    receipt_sha256: hash,
    approval_sha256: hash,
  });

  assert.throws(
    () =>
      advanceRunState(approved, {
        lifecycle_state: "applied",
        approval_sha256: undefined,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});
