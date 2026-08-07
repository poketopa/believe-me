import {
  EXECUTOR_KINDS,
  assertEnum,
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
} from "../contracts/common.js";
import { validateEvidenceReceipt } from "../contracts/evidence-receipt.js";
import { safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import {
  REVIEWABLE_LIFECYCLE_STATES,
  validateReviewEvidence,
} from "./review-evidence.js";
import {
  readBoundedRegularFileNoFollow,
  writeAtomicArtifactNoOverwrite,
} from "./safe-artifact.js";

export const PORTABLE_EVIDENCE_KIND = "believeme.portable-evidence";
export const PORTABLE_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const PORTABLE_EVIDENCE_FIELDS = Object.freeze([
  "schema_version",
  "bundle_kind",
  "export_context",
  "receipt_sha256",
  "receipt",
  "verification",
  "result",
]);
export const PORTABLE_EXPORT_CONTEXT_FIELDS = Object.freeze([
  "run_id",
  "lifecycle_state",
  "state_sha256",
  "executor_kind",
]);

function assertExactFields(value, fields, label) {
  assertObject(value, label);
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw safetyRefusal(`${label} is missing required field '${field}'.`, {
        field,
      });
    }
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw safetyRefusal(`${label} contains unsupported field '${field}'.`, {
        field,
      });
    }
  }
}

function translateExternalContractError(operation) {
  try {
    return operation();
  } catch (error) {
    if (
      error?.code === "safety_refusal" ||
      error?.code === "verification_failed"
    ) {
      throw error;
    }
    if (
      error?.code !== "usage_error" &&
      error?.code !== "persisted_schema_unsupported"
    ) {
      throw error;
    }
    throw safetyRefusal("Portable evidence bundle is malformed.", {
      cause_code: error?.code ?? null,
    });
  }
}

function validateExportContext(value) {
  assertExactFields(
    value,
    PORTABLE_EXPORT_CONTEXT_FIELDS,
    "Portable export context",
  );
  assertString(value.run_id, "export_context.run_id");
  assertEnum(
    value.lifecycle_state,
    "export_context.lifecycle_state",
    REVIEWABLE_LIFECYCLE_STATES,
  );
  assertSha256Hex(value.state_sha256, "export_context.state_sha256");
  assertEnum(
    value.executor_kind,
    "export_context.executor_kind",
    EXECUTOR_KINDS,
  );
  return deepFreeze(structuredClone(value));
}

function portableSummary(validated, bundleSha256, bundleBytes) {
  return deepFreeze({
    verification_status: "portable_evidence_verified",
    bundle_sha256: bundleSha256,
    bundle_bytes: bundleBytes,
    run_id: validated.run_id,
    lifecycle_state: validated.lifecycle_state,
    source_state_sha256: validated.state_sha256,
    executor_kind: validated.executor_kind,
    receipt_sha256: validated.receipt_sha256,
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

export function buildPortableEvidenceBundle({ state, stateSha256, evidence }) {
  const validated = validateReviewEvidence({ state, stateSha256, evidence });
  const value = deepFreeze({
    schema_version: { major: 1 },
    bundle_kind: PORTABLE_EVIDENCE_KIND,
    export_context: {
      run_id: validated.run_id,
      lifecycle_state: validated.lifecycle_state,
      state_sha256: validated.state_sha256,
      executor_kind: validated.executor_kind,
    },
    receipt_sha256: validated.receipt_sha256,
    receipt: validated.receipt,
    verification: validated.verification,
    result: validated.result,
  });
  const bytes = canonicalJSONLineBytes(value);
  if (bytes.byteLength > PORTABLE_EVIDENCE_MAX_BYTES) {
    throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.", {
      maximum_bytes: PORTABLE_EVIDENCE_MAX_BYTES,
      actual_bytes: bytes.byteLength,
    });
  }
  verifyPortableEvidenceBytes(bytes);
  return Object.freeze({
    value,
    bytes,
    bundle_sha256: sha256Hex(bytes),
    receipt_sha256: validated.receipt_sha256,
    run_id: validated.run_id,
  });
}

export function verifyPortableEvidenceBytes(bytes) {
  return translateExternalContractError(() => {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      throw safetyRefusal("Portable evidence bundle must not be empty.");
    }
    if (bytes.byteLength > PORTABLE_EVIDENCE_MAX_BYTES) {
      throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.", {
        maximum_bytes: PORTABLE_EVIDENCE_MAX_BYTES,
        actual_bytes: bytes.byteLength,
      });
    }
    let line;
    try {
      line = fatalUtf8Decoder.decode(bytes);
    } catch {
      throw safetyRefusal("Portable evidence bundle must be valid UTF-8.");
    }
    if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
      throw safetyRefusal(
        "Portable evidence bundle must be exactly one JSON line.",
      );
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw safetyRefusal("Portable evidence bundle JSON is malformed.");
    }
    if (!canonicalJSONLineBytes(value).equals(bytes)) {
      throw safetyRefusal("Portable evidence bundle is not canonical JSONL.");
    }
    assertExactFields(
      value,
      PORTABLE_EVIDENCE_FIELDS,
      "Portable evidence bundle",
    );
    if (
      value.schema_version === null ||
      typeof value.schema_version !== "object" ||
      Array.isArray(value.schema_version) ||
      Object.keys(value.schema_version).length !== 1 ||
      value.schema_version.major !== 1
    ) {
      throw safetyRefusal("Portable evidence bundle schema is unsupported.");
    }
    if (value.bundle_kind !== PORTABLE_EVIDENCE_KIND) {
      throw safetyRefusal("Portable evidence bundle kind is unsupported.");
    }
    const context = validateExportContext(value.export_context);
    assertSha256Hex(value.receipt_sha256, "receipt_sha256");
    const receipt = validateEvidenceReceipt(value.receipt, { persisted: true });
    const actualReceiptSha256 = sha256Hex(canonicalJSONLineBytes(receipt));
    if (actualReceiptSha256 !== value.receipt_sha256) {
      throw safetyRefusal("Portable evidence receipt digest mismatch.", {
        expected_sha256: value.receipt_sha256,
        actual_sha256: actualReceiptSha256,
      });
    }
    const verificationSha256 = sha256Hex(
      canonicalJSONLineBytes(value.verification),
    );
    if (verificationSha256 !== receipt.verification_sha256) {
      throw safetyRefusal("Portable verification digest mismatch.");
    }
    const resultSha256 = sha256Hex(canonicalJSONLineBytes(value.result));
    if (resultSha256 !== receipt.result_sha256) {
      throw safetyRefusal("Portable result digest mismatch.");
    }
    const state = {
      run_id: context.run_id,
      lifecycle_state: context.lifecycle_state,
      manifest_sha256: receipt.manifest_sha256,
      workflow_plan_sha256: receipt.workflow_plan_sha256,
      source_snapshot_sha256: receipt.source_snapshot_sha256,
      executor_kind: context.executor_kind,
      receipt_sha256: value.receipt_sha256,
    };
    const validated = validateReviewEvidence({
      state,
      stateSha256: context.state_sha256,
      evidence: {
        receipt_sha256: value.receipt_sha256,
        receipt,
        verification: value.verification,
        result: value.result,
      },
    });
    return portableSummary(validated, sha256Hex(bytes), bytes.byteLength);
  });
}

const PORTABLE_ARTIFACT_MESSAGES = Object.freeze({
  bytesMalformed: "Portable evidence bundle bytes are malformed.",
  exceedsLimit: "Portable evidence bundle exceeds the 64 MiB limit.",
  parentMissing: "Portable bundle output parent does not exist.",
  parentRealDirectory:
    "Portable bundle output parent must be a real directory path.",
  noFollowDirectoryUnsupported:
    "Portable evidence export requires no-follow directory support.",
  outputExists: "Portable bundle output path already exists.",
  parentIdentityChanged: "Portable bundle output parent identity changed.",
  missing: "Portable evidence bundle does not exist.",
  regularFile: "Portable evidence bundle must be a regular file.",
  noFollowFileUnsupported:
    "Portable evidence verification requires no-follow file support.",
  identityChanged: "Portable evidence bundle identity changed.",
});

export async function writePortableEvidenceBundle(path, bytes, options = {}) {
  const published = await writeAtomicArtifactNoOverwrite(path, bytes, {
    ...options,
    maxBytes: PORTABLE_EVIDENCE_MAX_BYTES,
    temporaryPrefix: "believeme-portable",
    messages: PORTABLE_ARTIFACT_MESSAGES,
  });
  return deepFreeze({
    output_path: published.output_path,
    bundle_bytes: published.bytes,
    bundle_sha256: published.sha256,
  });
}

export async function readPortableEvidenceBundle(path, options = {}) {
  const { bytes } = await readBoundedRegularFileNoFollow(path, {
    ...options,
    maxBytes: PORTABLE_EVIDENCE_MAX_BYTES,
    messages: PORTABLE_ARTIFACT_MESSAGES,
  });
  return verifyPortableEvidenceBytes(bytes);
}
