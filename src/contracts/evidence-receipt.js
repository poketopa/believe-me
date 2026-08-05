import {
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";

export const EVIDENCE_RECEIPT_REQUIRED_FIELDS = Object.freeze([
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

export function validateEvidenceReceipt(value, options = {}) {
  validateContractBase(
    value,
    EVIDENCE_RECEIPT_REQUIRED_FIELDS,
    "EvidenceReceipt",
    options,
  );
  if (Object.hasOwn(value, "receipt_sha256")) {
    throw usageError("EvidenceReceipt must not carry a self-hash field.", {
      field: "receipt_sha256",
    });
  }
  assertString(value.run_id, "run_id");
  assertSha256Hex(value.manifest_sha256, "manifest_sha256");
  assertSha256Hex(value.workflow_plan_sha256, "workflow_plan_sha256");
  assertSha256Hex(value.source_snapshot_sha256, "source_snapshot_sha256");
  assertSha256Hex(value.verification_sha256, "verification_sha256");
  assertSha256Hex(value.result_sha256, "result_sha256");
  if (value.approval_method !== "receipt_sha256") {
    throw usageError("approval_method must be exactly 'receipt_sha256'.", {
      field: "approval_method",
    });
  }
  assertString(value.issued_at, "issued_at");
  return deepFreeze(structuredClone(value));
}

export const freezeEvidenceReceipt = validateEvidenceReceipt;
