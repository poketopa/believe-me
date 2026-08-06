import { safetyRefusal, verificationFailed } from "../contracts/errors.js";
import { validateExecutorResult } from "../contracts/executor.js";
import { deepFreeze } from "../contracts/common.js";

export const REVIEWABLE_LIFECYCLE_STATES = Object.freeze([
  "verified",
  "receipted",
  "approved",
  "applied",
  "rolled_back",
]);

export function assertEvidenceReceiptBoundToState(state, evidence) {
  if (
    !state.receipt_sha256 ||
    state.receipt_sha256 !== evidence.receipt_sha256
  ) {
    throw safetyRefusal("Receipt hash does not match persisted run state.");
  }
  for (const field of [
    "run_id",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
  ]) {
    if (state[field] !== evidence.receipt[field]) {
      throw safetyRefusal(`Receipt field '${field}' does not match run state.`, {
        field,
      });
    }
  }
}

export function assertReviewableLifecycle(state) {
  if (!REVIEWABLE_LIFECYCLE_STATES.includes(state.lifecycle_state)) {
    throw safetyRefusal("Run lifecycle state cannot be reviewed.", {
      run_id: state.run_id,
      lifecycle_state: state.lifecycle_state,
      allowed_lifecycle_states: REVIEWABLE_LIFECYCLE_STATES,
    });
  }
}

function validateReviewVerification(verification) {
  if (
    verification === null ||
    typeof verification !== "object" ||
    Array.isArray(verification)
  ) {
    throw safetyRefusal("Stored verification artifact is malformed.");
  }
  if (
    verification.schema_version === null ||
    typeof verification.schema_version !== "object" ||
    Array.isArray(verification.schema_version) ||
    verification.schema_version.major !== 1
  ) {
    throw safetyRefusal("Stored verification artifact schema is unsupported.", {
      schema_version: verification.schema_version ?? null,
    });
  }
  if (
    typeof verification.adapter_id !== "string" ||
    verification.adapter_id.length === 0
  ) {
    throw safetyRefusal("Stored verification artifact is missing adapter_id.");
  }
  if (
    typeof verification.status !== "string" ||
    verification.status.length === 0
  ) {
    throw safetyRefusal("Stored verification artifact is missing status.");
  }
  if (verification.status !== "passed") {
    throw verificationFailed("Stored verification artifact did not pass.", {
      adapter_id: verification.adapter_id,
      status: verification.status,
    });
  }
  return verification;
}

function validateReviewResult(result, state) {
  let validated;
  try {
    validated = validateExecutorResult(result, { persisted: true });
  } catch (error) {
    throw safetyRefusal("Stored result artifact is malformed.", {
      cause_code: error.code ?? null,
    });
  }
  if (validated.run_id !== state.run_id) {
    throw safetyRefusal("Evidence result run id does not match run state.", {
      expected_run_id: state.run_id,
      actual_run_id: validated.run_id,
    });
  }
  if (validated.executor_kind !== state.executor_kind) {
    throw safetyRefusal(
      "Evidence result executor kind does not match run state.",
      {
        expected_executor_kind: state.executor_kind,
        actual_executor_kind: validated.executor_kind,
      },
    );
  }
  return validated;
}

function freezeChanges(changes) {
  return Object.freeze(changes.map((change) => Object.freeze({
    path: change.path,
    sha256: change.sha256,
  })));
}

export function validateReviewEvidence({ state, stateSha256, evidence }) {
  assertReviewableLifecycle(state);
  assertEvidenceReceiptBoundToState(state, evidence);
  const verification = validateReviewVerification(evidence.verification);
  const result = validateReviewResult(evidence.result, state);

  return deepFreeze({
    run_id: state.run_id,
    lifecycle_state: state.lifecycle_state,
    state_sha256: stateSha256,
    executor_kind: state.executor_kind,
    receipt_sha256: evidence.receipt_sha256,
    receipt: structuredClone(evidence.receipt),
    verification: structuredClone(verification),
    result: structuredClone(result),
    changes: freezeChanges(result.changes),
  });
}

export function storedReviewSummary(validated) {
  return deepFreeze({
    run_id: validated.run_id,
    lifecycle_state: validated.lifecycle_state,
    state_sha256: validated.state_sha256,
    review_status: "stored_evidence_verified",
    approval: {
      method: validated.receipt.approval_method,
      receipt_sha256: validated.receipt_sha256,
    },
    bindings: {
      manifest_sha256: validated.receipt.manifest_sha256,
      workflow_plan_sha256: validated.receipt.workflow_plan_sha256,
      source_snapshot_sha256: validated.receipt.source_snapshot_sha256,
      verification_sha256: validated.receipt.verification_sha256,
      result_sha256: validated.receipt.result_sha256,
    },
    verification: {
      adapter_id: validated.verification.adapter_id,
      status: validated.verification.status,
    },
    changes: validated.changes,
  });
}
