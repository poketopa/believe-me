import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateEvidenceReceipt } from "../contracts/evidence-receipt.js";
import { safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import { readRegularFileNoFollow } from "./snapshot.js";

const RECEIPT_FILE = "receipt.jsonl";
const RECEIPT_DIGEST_FILE = "receipt.sha256";
const VERIFICATION_FILE = "verification.jsonl";
const RESULT_FILE = "result.jsonl";
const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/;

async function atomicWriteFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await link(tmp, path);
    await rm(tmp, { force: true });
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function assertSingleJsonLine(line, label) {
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal(`${label} must be exactly one JSON line.`);
  }
}

function parsePersistedJsonLine(line, label) {
  assertSingleJsonLine(line, label);
  try {
    return JSON.parse(line);
  } catch {
    throw safetyRefusal(`${label} JSON is malformed.`);
  }
}

async function readJsonLineWithExpectedHash(path, expectedSha256, label) {
  const { bytes } = await readRegularFileNoFollow(path, label);
  const line = bytes.toString("utf8");
  assertSingleJsonLine(line, label);
  const actualSha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (actualSha256 !== expectedSha256) {
    throw safetyRefusal(`${label} digest mismatch.`, {
      expected_sha256: expectedSha256,
      actual_sha256: actualSha256,
    });
  }
  const value = parsePersistedJsonLine(line, label);
  const canonicalSha256 = sha256Hex(canonicalJSONLineBytes(value));
  if (canonicalSha256 !== actualSha256) {
    throw safetyRefusal(`${label} is not canonical JSONL.`, {
      expected_sha256: canonicalSha256,
      actual_sha256: actualSha256,
    });
  }
  return { value, sha256: actualSha256 };
}

export function evidencePaths(artifactRoot) {
  return Object.freeze({
    receipt: join(artifactRoot, RECEIPT_FILE),
    receiptDigest: join(artifactRoot, RECEIPT_DIGEST_FILE),
    verification: join(artifactRoot, VERIFICATION_FILE),
    result: join(artifactRoot, RESULT_FILE),
  });
}

export async function writeEvidenceBundle(options) {
  const {
    artifactRoot,
    runState,
    verification,
    result,
    issuedAt = new Date().toISOString(),
  } = options;
  const paths = evidencePaths(artifactRoot);

  const verificationLine = canonicalJSONLine(verification);
  const resultLine = canonicalJSONLine(result);
  const verificationSha256 = sha256Hex(Buffer.from(verificationLine, "utf8"));
  const resultSha256 = sha256Hex(Buffer.from(resultLine, "utf8"));

  const receipt = validateEvidenceReceipt({
    schema_version: { major: 1 },
    run_id: runState.run_id,
    manifest_sha256: runState.manifest_sha256,
    workflow_plan_sha256: runState.workflow_plan_sha256,
    source_snapshot_sha256: runState.source_snapshot_sha256,
    verification_sha256: verificationSha256,
    result_sha256: resultSha256,
    approval_method: "receipt_sha256",
    issued_at: issuedAt,
  });
  const receiptLine = canonicalJSONLine(receipt);
  const receiptSha256 = sha256Hex(Buffer.from(receiptLine, "utf8"));

  await atomicWriteFile(paths.verification, verificationLine);
  await atomicWriteFile(paths.result, resultLine);
  await atomicWriteFile(paths.receipt, receiptLine);
  await atomicWriteFile(paths.receiptDigest, `${receiptSha256}\n`);

  return {
    paths,
    receipt,
    receipt_sha256: receiptSha256,
    verification_sha256: verificationSha256,
    result_sha256: resultSha256,
  };
}

export async function readEvidenceBundle(artifactRoot) {
  const paths = evidencePaths(artifactRoot);
  const [receiptBytes, receiptDigestBytes] = await Promise.all([
    readRegularFileNoFollow(paths.receipt, "Evidence receipt"),
    readRegularFileNoFollow(paths.receiptDigest, "Evidence receipt digest"),
  ]);
  const receiptLine = receiptBytes.bytes.toString("utf8");
  const receiptDigestLine = receiptDigestBytes.bytes.toString("utf8");

  assertSingleJsonLine(receiptLine, "Evidence receipt");
  if (!SHA256_LINE_PATTERN.test(receiptDigestLine)) {
    throw safetyRefusal(
      "Evidence receipt digest must be exactly one lowercase SHA-256 line.",
    );
  }

  const receiptSha256 = sha256Hex(Buffer.from(receiptLine, "utf8"));
  const expectedReceiptSha256 = receiptDigestLine.slice(0, -1);
  if (receiptSha256 !== expectedReceiptSha256) {
    throw safetyRefusal("Evidence receipt digest mismatch.", {
      expected_sha256: expectedReceiptSha256,
      actual_sha256: receiptSha256,
    });
  }

  const receipt = validateEvidenceReceipt(
    parsePersistedJsonLine(receiptLine, "Evidence receipt"),
    { persisted: true },
  );
  const canonicalReceiptSha256 = sha256Hex(canonicalJSONLineBytes(receipt));
  if (canonicalReceiptSha256 !== receiptSha256) {
    throw safetyRefusal("Evidence receipt is not canonical JSONL.", {
      expected_sha256: canonicalReceiptSha256,
      actual_sha256: receiptSha256,
    });
  }

  const [verification, result] = await Promise.all([
    readJsonLineWithExpectedHash(
      paths.verification,
      receipt.verification_sha256,
      "Verification artifact",
    ),
    readJsonLineWithExpectedHash(
      paths.result,
      receipt.result_sha256,
      "Result artifact",
    ),
  ]);

  return Object.freeze({
    paths,
    receipt,
    receipt_sha256: receiptSha256,
    verification: verification.value,
    result: result.value,
  });
}
