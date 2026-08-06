import { constants } from "node:fs";
import { link, lstat, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import {
  EXECUTOR_KINDS,
  assertEnum,
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
} from "../contracts/common.js";
import { validateEvidenceReceipt } from "../contracts/evidence-receipt.js";
import { notFound, safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import {
  REVIEWABLE_LIFECYCLE_STATES,
  validateReviewEvidence,
} from "./review-evidence.js";

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

async function assertRealDirectoryPath(path) {
  const { root } = parse(path);
  let current = root;
  let currentStats = await lstat(root);
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    currentStats = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") {
        throw notFound("Portable bundle output parent does not exist.", {
          path,
        });
      }
      throw error;
    });
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) {
      throw safetyRefusal(
        "Portable bundle output parent must be a real directory path.",
        { path },
      );
    }
  }
  return currentStats;
}

async function assertOpenParentIdentity(path, handle, expected) {
  const [opened, current] = await Promise.all([
    handle.stat(),
    lstat(path),
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !opened.isDirectory() ||
    opened.dev !== expected.dev ||
    opened.ino !== expected.ino ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw safetyRefusal("Portable bundle output parent identity changed.", {
      path,
    });
  }
}

async function removeFileFromOriginalParent(filePath, expectedParent, handle) {
  if (handle === undefined) {
    return;
  }
  const parent = dirname(filePath);
  const current = await lstat(parent).catch(() => null);
  if (
    current !== null &&
    !current.isSymbolicLink() &&
    current.isDirectory() &&
    current.dev === expectedParent.dev &&
    current.ino === expectedParent.ino
  ) {
    await removePathIfHandleIdentity(filePath, handle);
    return;
  }

  const container = dirname(parent);
  const names = await readdir(container).catch(() => []);
  for (const name of names) {
    const candidate = join(container, name);
    const stats = await lstat(candidate).catch(() => null);
    if (
      stats !== null &&
      !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      stats.dev === expectedParent.dev &&
      stats.ino === expectedParent.ino
    ) {
      await removePathIfHandleIdentity(join(candidate, basename(filePath)), handle);
      return;
    }
  }
}

async function removePathIfHandleIdentity(path, handle) {
  const [opened, current] = await Promise.all([
    handle.stat(),
    lstat(path).catch(() => null),
  ]);
  if (
    current !== null &&
    current.isFile() &&
    current.dev === opened.dev &&
    current.ino === opened.ino
  ) {
    await rm(path, { force: true });
  }
}

export async function writePortableEvidenceBundle(path, bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw safetyRefusal("Portable evidence bundle bytes are malformed.");
  }
  if (bytes.byteLength > PORTABLE_EVIDENCE_MAX_BYTES) {
    throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.");
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputPath = resolve(cwd, path);
  const parent = dirname(outputPath);
  const parentStats = await assertRealDirectoryPath(parent);
  if (
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined
  ) {
    throw safetyRefusal(
      "Portable evidence export requires no-follow directory support.",
    );
  }
  const existing = await lstat(outputPath).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing !== null) {
    throw safetyRefusal("Portable bundle output path already exists.", {
      path: outputPath,
    });
  }
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  ).catch((error) => {
    if (error.code === "ELOOP" || error.code === "ENOTDIR") {
      throw safetyRefusal(
        "Portable bundle output parent must be a real directory path.",
        { path: parent },
      );
    }
    throw error;
  });
  await assertOpenParentIdentity(parent, parentHandle, parentStats).catch(
    async (error) => {
      await parentHandle.close();
      throw error;
    },
  );

  const temporaryPath = resolve(
    parent,
    `.believeme-portable.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let publishing = false;
  let published = false;
  const writeBytes = options.writeBytes ?? ((file, content) =>
    file.writeFile(content));
  const openTemporary = options.openTemporary ?? ((candidatePath) =>
    open(candidatePath, "wx", 0o600));
  const publishLink = options.publishLink ?? link;
  try {
    await options.beforeTemporaryOpen?.({ parent, temporaryPath });
    await assertOpenParentIdentity(parent, parentHandle, parentStats);
    handle = await openTemporary(temporaryPath);
    await assertOpenParentIdentity(parent, parentHandle, parentStats);
    await writeBytes(handle, bytes);
    await handle.sync();
    await assertOpenParentIdentity(parent, parentHandle, parentStats);
    publishing = true;
    await publishLink(temporaryPath, outputPath);
    await assertOpenParentIdentity(parent, parentHandle, parentStats);
    published = true;
    return deepFreeze({
      output_path: outputPath,
      bundle_bytes: bytes.byteLength,
      bundle_sha256: sha256Hex(bytes),
    });
  } catch (error) {
    if (handle !== undefined && !published) {
      await handle.truncate(0);
      await handle.sync();
      if (publishing) {
        await removePathIfHandleIdentity(outputPath, handle);
        await removeFileFromOriginalParent(outputPath, parentStats, handle);
      }
    }
    if (publishing && error?.code === "EEXIST") {
      throw safetyRefusal("Portable bundle output path already exists.", {
        path: outputPath,
      });
    }
    throw error;
  } finally {
    try {
      if (handle !== undefined) {
        await removePathIfHandleIdentity(temporaryPath, handle);
        await removeFileFromOriginalParent(temporaryPath, parentStats, handle);
      }
    } finally {
      try {
        await handle?.close();
      } finally {
        await parentHandle.close();
      }
    }
  }
}

async function boundedRead(handle) {
  const chunks = [];
  let total = 0;
  while (total <= PORTABLE_EVIDENCE_MAX_BYTES) {
    const length = Math.min(
      64 * 1024,
      PORTABLE_EVIDENCE_MAX_BYTES + 1 - total,
    );
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > PORTABLE_EVIDENCE_MAX_BYTES) {
    throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.");
  }
  return Buffer.concat(chunks, total);
}

export async function readPortableEvidenceBundle(path, options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const inputPath = resolve(cwd, path);
  const before = await lstat(inputPath).catch((error) => {
    if (error.code === "ENOENT") {
      throw notFound("Portable evidence bundle does not exist.", {
        path: inputPath,
      });
    }
    throw error;
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw safetyRefusal("Portable evidence bundle must be a regular file.", {
      path: inputPath,
    });
  }
  if (before.size > PORTABLE_EVIDENCE_MAX_BYTES) {
    throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.");
  }
  if (constants.O_NOFOLLOW === undefined) {
    throw safetyRefusal(
      "Portable evidence verification requires no-follow file support.",
    );
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(inputPath, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw safetyRefusal("Portable evidence bundle identity changed.", {
        path: inputPath,
      });
    }
    if (opened.size > PORTABLE_EVIDENCE_MAX_BYTES) {
      throw safetyRefusal("Portable evidence bundle exceeds the 64 MiB limit.");
    }
    const bytes = await boundedRead(handle);
    await options.afterRead?.({ inputPath });
    const closedSnapshot = await handle.stat();
    const after = await lstat(inputPath);
    if (
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      closedSnapshot.size !== bytes.byteLength ||
      after.size !== bytes.byteLength
    ) {
      throw safetyRefusal("Portable evidence bundle identity changed.", {
        path: inputPath,
      });
    }
    return verifyPortableEvidenceBytes(bytes);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw notFound("Portable evidence bundle does not exist.", {
        path: inputPath,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
