import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { readEvidenceBundle } from "./evidence.js";
import { sha256Hex } from "./hash.js";
import { advanceStoredRunState, readRunState } from "./state-store.js";
import {
  assertInsideRoot,
  compareCodeUnit,
  createProjectSnapshot,
  isExcludedRelativePath,
  normalizeRelativePath,
  readRegularFileNoFollow,
} from "./snapshot.js";
import {
  VerificationRollbackError,
  captureOriginalBytes,
  restoreOriginalBytes,
  safeReplaceFile,
} from "./rollback.js";

const LOCK_FILE = "apply.lock.jsonl";
const RECOVERY_LOCK_FILE = "apply.recovery.lock.jsonl";
const JOURNAL_FILE = "apply-journal.jsonl";
const JOURNAL_DIGEST_FILE = "apply-journal.sha256";
const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/;

function verifierFailure(message, details = {}, cause = undefined) {
  return new VerificationRollbackError(message, details, cause);
}

function nowIso() {
  return new Date().toISOString();
}

function assertSchemaVersion(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version?.major !== 1
  ) {
    throw usageError(`${label} schema_version.major must be 1.`);
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw safetyRefusal(`${label} must be an object.`);
  }
}

function decodeCanonicalBase64(value, label, details = {}) {
  if (typeof value !== "string") {
    throw safetyRefusal(`${label} must be a base64 string.`, details);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw safetyRefusal(`${label} is not canonical base64.`, details);
  }
  return bytes;
}

function decodeCandidateBytes(change) {
  return decodeCanonicalBase64(change.content_base64, "Candidate content", {
    path: change.path,
  });
}

async function assertRegularOrMissing(absolutePath, relativePath) {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw safetyRefusal("Apply refuses symlink targets.", {
        path: relativePath,
      });
    }
    if (!stats.isFile()) {
      throw safetyRefusal("Apply only mutates regular file targets.", {
        path: relativePath,
      });
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertSafeStateDir(stateDir) {
  const resolved = resolve(stateDir);
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal("stateDir must be a real directory.", {
      state_dir: resolved,
    });
  }
  return resolved;
}

function runDirectory(stateDir, runId) {
  return join(resolve(stateDir), "runs", runId);
}

function expectedArtifactRoot(stateDir, runId) {
  return join(runDirectory(stateDir, runId), "artifacts");
}

function applyPaths(stateDir, runId) {
  const dir = runDirectory(stateDir, runId);
  return Object.freeze({
    runDir: dir,
    lock: join(dir, LOCK_FILE),
    recoveryLock: join(dir, RECOVERY_LOCK_FILE),
    journal: join(dir, JOURNAL_FILE),
    journalDigest: join(dir, JOURNAL_DIGEST_FILE),
  });
}

async function fsyncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeCanonicalFileAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const line = canonicalJSONLine(value);
  const tmp = join(
    dirname(path),
    `.${path.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(line, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
    await chmod(path, mode);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close();
    await rm(tmp, { force: true });
    throw error;
  }
}

async function createExclusiveCanonicalFile(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const line = canonicalJSONLine(value);
  const tmp = join(
    dirname(path),
    `.${path.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(line, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(tmp, path);
    await chmod(path, mode);
    await fsyncDirectory(dirname(path));
    await rm(tmp, { force: true });
  } catch (error) {
    await handle?.close();
    await rm(tmp, { force: true });
    if (error?.code === "EEXIST") {
      throw error;
    }
    throw error;
  }
}

async function writeCanonicalJsonlWithSidecar(path, digestPath, value) {
  await writeCanonicalFileAtomic(path, value, 0o600);
  const line = canonicalJSONLine(value);
  await writeFile(digestPath, `${sha256Hex(Buffer.from(line, "utf8"))}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  await chmod(digestPath, 0o600);
  await fsyncDirectory(dirname(digestPath));
}

async function readCanonicalJsonl(path, label) {
  const line = await readFile(path, "utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal(`${label} must be exactly one JSON line.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw safetyRefusal(`${label} JSON is malformed.`);
  }
  const actual = sha256Hex(Buffer.from(line, "utf8"));
  const canonical = sha256Hex(canonicalJSONLineBytes(parsed));
  if (canonical !== actual) {
    throw safetyRefusal(`${label} is not canonical JSONL.`, {
      expected_sha256: canonical,
      actual_sha256: actual,
    });
  }
  return parsed;
}

async function readCanonicalJsonlWithSidecar(path, digestPath, label) {
  const [value, digestLine] = await Promise.all([
    readCanonicalJsonl(path, label),
    readFile(digestPath, "utf8"),
  ]);
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(`${label} digest must be one lowercase SHA-256 line.`);
  }
  const actual = sha256Hex(canonicalJSONLineBytes(value));
  const expected = digestLine.slice(0, -1);
  if (actual !== expected) {
    throw safetyRefusal(`${label} digest mismatch.`, {
      expected_sha256: expected,
      actual_sha256: actual,
    });
  }
  return value;
}

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateLock(value, operation, runId) {
  assertObject(value, "Apply lock");
  assertSchemaVersion(value, "Apply lock");
  const allowedKeys = new Set([
    "schema_version",
    "operation",
    "run_id",
    "pid",
    "owner_token",
    "created_at",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw safetyRefusal("Apply lock contains unsupported metadata.", {
        run_id: runId,
        field: key,
      });
    }
  }
  if (value.operation !== operation || value.run_id !== runId) {
    throw safetyRefusal("Apply lock metadata mismatch.", {
      operation,
      run_id: runId,
    });
  }
  if (
    !Number.isInteger(value.pid) ||
    typeof value.owner_token !== "string" ||
    value.owner_token.length === 0 ||
    typeof value.created_at !== "string"
  ) {
    throw safetyRefusal("Apply lock metadata is incomplete.", { run_id: runId });
  }
  return value;
}

async function readLock(path, operation, runId) {
  return validateLock(await readCanonicalJsonl(path, "Apply lock"), operation, runId);
}

async function removeLock(path) {
  await rm(path, { force: true });
  await fsyncDirectory(dirname(path));
}

async function removeOwnedLock(path, operation, runId, ownerToken) {
  const current = await readLock(path, operation, runId);
  if (current.owner_token !== ownerToken) {
    throw safetyRefusal("Lock owner token mismatch during release.", {
      run_id: runId,
    });
  }
  await removeLock(path);
}

async function cleanupJournal(paths) {
  await rm(paths.journal, { force: true });
  await rm(paths.journalDigest, { force: true });
  await fsyncDirectory(paths.runDir);
}

async function cleanupTerminal(paths) {
  await cleanupJournal(paths);
  await removeLock(paths.lock);
}

function makeLock(operation, runId, ownerToken) {
  return {
    schema_version: { major: 1 },
    operation,
    run_id: runId,
    pid: process.pid,
    owner_token: ownerToken,
    created_at: nowIso(),
  };
}

async function createLockFile(path, operation, runId, ownerToken) {
  await createExclusiveCanonicalFile(path, makeLock(operation, runId, ownerToken));
}

async function claimRecovery(paths, runId) {
  const ownerToken = randomUUID();
  try {
    await createLockFile(paths.recoveryLock, "apply_recovery", runId, ownerToken);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readLock(paths.recoveryLock, "apply_recovery", runId);
      throw safetyRefusal("Apply recovery lock already exists.", {
        run_id: runId,
        pid: existing.pid,
      });
    }
    throw error;
  }
  return {
    ownerToken,
    async release() {
      await removeOwnedLock(
        paths.recoveryLock,
        "apply_recovery",
        runId,
        ownerToken,
      );
    },
  };
}

async function assertNoActiveRecoveryLock(paths, runId) {
  let existing;
  try {
    existing = await readLock(paths.recoveryLock, "apply_recovery", runId);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw safetyRefusal("Apply recovery lock already exists.", {
    run_id: runId,
    pid: existing.pid,
  });
}

async function acquireApplyLock(stateDir, runId, projectRoot) {
  const paths = applyPaths(stateDir, runId);
  await assertNoActiveRecoveryLock(paths, runId);
  const ownerToken = randomUUID();
  try {
    await createLockFile(paths.lock, "apply", runId, ownerToken);
    return {
      paths,
      ownerToken,
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readLock(paths.lock, "apply", runId);
  if (processIsLive(existing.pid)) {
    throw safetyRefusal("Apply lock is held by a live process.", {
      run_id: runId,
      pid: existing.pid,
    });
  }

  const recovery = await claimRecovery(paths, runId);
  try {
    const rechecked = await readLock(paths.lock, "apply", runId);
    if (processIsLive(rechecked.pid)) {
      throw safetyRefusal("Apply lock became live before recovery.", {
        run_id: runId,
        pid: rechecked.pid,
      });
    }
    const recoveryResult = await recoverClaimedStaleApply({
      stateDir,
      runId,
      projectRoot,
      paths,
    });
    if (recoveryResult.terminal) {
      await recovery.release();
      return { terminal: recoveryResult };
    }
    await createLockFile(paths.lock, "apply", runId, ownerToken);
    await recovery.release();
    return {
      paths,
      ownerToken,
    };
  } catch (error) {
    await recovery.release().catch(() => {});
    throw error;
  }
}

async function assertNoSymlinkComponentsBelowStateDir(stateDir, targetPath) {
  const root = await assertSafeStateDir(stateDir);
  const target = resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw safetyRefusal("Artifact path escapes state directory.", {
      state_dir: root,
      path: target,
    });
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw safetyRefusal("State path contains a symlink component.", {
        path: current,
      });
    }
  }
}

async function assertArtifactRoot(stateDir, runId, artifactRoot) {
  const expected = expectedArtifactRoot(stateDir, runId);
  if (resolve(artifactRoot) !== expected) {
    throw safetyRefusal("Run artifact_root must match canonical per-run path.", {
      expected_artifact_root: expected,
      actual_artifact_root: artifactRoot,
    });
  }
  await assertNoSymlinkComponentsBelowStateDir(stateDir, expected);
}

async function normalizeDeclaredChanges(projectRoot, result) {
  assertSchemaVersion(result, "Result artifact");
  if (!Array.isArray(result.changes) || result.changes.length === 0) {
    throw safetyRefusal("Result artifact must declare at least one change.");
  }

  const seen = new Set();
  const targets = [];
  for (const change of result.changes) {
    assertObject(change, "Result change");
    const relativePath = normalizeRelativePath(projectRoot, change.path);
    if (isExcludedRelativePath(relativePath)) {
      throw safetyRefusal("Apply refuses excluded paths.", {
        path: relativePath,
      });
    }
    if (seen.has(relativePath)) {
      throw safetyRefusal("Apply refuses duplicate changed paths.", {
        path: relativePath,
      });
    }
    seen.add(relativePath);

    const bytes = decodeCandidateBytes(change);
    const candidateSha256 = sha256Hex(bytes);
    if (change.sha256 !== candidateSha256) {
      throw safetyRefusal("Candidate change digest mismatch.", {
        path: relativePath,
        expected_sha256: change.sha256,
        actual_sha256: candidateSha256,
      });
    }

    const absolutePath = assertInsideRoot(projectRoot, relativePath);
    await assertRegularOrMissing(absolutePath, relativePath);
    targets.push({
      relativePath,
      absolutePath,
      bytes,
      sha256: candidateSha256,
    });
  }

  targets.sort((left, right) =>
    compareCodeUnit(left.relativePath, right.relativePath),
  );
  return targets;
}

async function markRolledBack(stateDir, runId, observed) {
  return advanceStoredRunState(
    stateDir,
    runId,
    { lifecycle_state: "rolled_back" },
    { observed },
  );
}

function journalFromOriginals({
  runId,
  projectRoot,
  receiptSha256,
  targets,
  originals,
}) {
  return {
    schema_version: { major: 1 },
    operation: "apply",
    run_id: runId,
    project_path: resolve(projectRoot),
    receipt_sha256: receiptSha256,
    targets: targets.map((target) => target.relativePath),
    candidates: targets.map((target) => ({
      path: target.relativePath,
      sha256: target.sha256,
    })),
    originals: targets.map((target) => {
      const original = originals.get(target.relativePath);
      return {
        path: target.relativePath,
        existed: original.existed,
        mode: original.mode,
        dev: original.dev,
        ino: original.ino,
        sha256: original.sha256,
        content_base64: original.bytes.toString("base64"),
      };
    }),
  };
}

function validateJournal(journal, { runId, projectRoot, receiptSha256 }) {
  assertObject(journal, "Apply rollback journal");
  assertSchemaVersion(journal, "Apply rollback journal");
  if (
    journal.operation !== "apply" ||
    journal.run_id !== runId ||
    resolve(journal.project_path) !== resolve(projectRoot) ||
    journal.receipt_sha256 !== receiptSha256
  ) {
    throw safetyRefusal("Apply rollback journal metadata mismatch.", {
      run_id: runId,
    });
  }
  if (
    !Array.isArray(journal.targets) ||
    !Array.isArray(journal.candidates) ||
    !Array.isArray(journal.originals)
  ) {
    throw safetyRefusal("Apply rollback journal path sets are malformed.", {
      run_id: runId,
    });
  }

  const targetSet = new Set(journal.targets);
  if (
    targetSet.size !== journal.targets.length ||
    journal.candidates.length !== journal.targets.length ||
    journal.originals.length !== journal.targets.length
  ) {
    throw safetyRefusal("Apply rollback journal path sets do not match.", {
      run_id: runId,
    });
  }
  for (const path of journal.targets) {
    normalizeRelativePath(projectRoot, path);
  }
  const candidateSeen = new Set();
  for (const candidate of journal.candidates) {
    assertObject(candidate, "Apply rollback journal candidate");
    if (
      !targetSet.has(candidate.path) ||
      candidateSeen.has(candidate.path) ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256)
    ) {
      throw safetyRefusal("Apply rollback journal candidate is invalid.", {
        path: candidate.path,
      });
    }
    candidateSeen.add(candidate.path);
  }
  const originalSeen = new Set();
  for (const original of journal.originals) {
    assertObject(original, "Apply rollback journal original");
    if (
      !targetSet.has(original.path) ||
      originalSeen.has(original.path) ||
      typeof original.existed !== "boolean"
    ) {
      throw safetyRefusal("Apply rollback journal original is invalid.", {
        path: original.path,
      });
    }
    originalSeen.add(original.path);
    const bytes = decodeCanonicalBase64(original.content_base64, "Original bytes", {
      path: original.path,
    });
    if (original.existed) {
      if (
        !Number.isInteger(original.mode) ||
        original.mode < 0 ||
        original.mode > 0o777 ||
        !Number.isInteger(original.dev) ||
        !Number.isInteger(original.ino)
      ) {
        throw safetyRefusal("Apply rollback journal original mode is invalid.", {
          path: original.path,
        });
      }
      if (sha256Hex(bytes) !== original.sha256) {
        throw safetyRefusal("Apply rollback journal original hash mismatch.", {
          path: original.path,
        });
      }
    } else if (
      original.sha256 !== null ||
      original.mode !== null ||
      original.dev !== null ||
      original.ino !== null ||
      bytes.length !== 0
    ) {
      throw safetyRefusal("Apply rollback journal absent original is invalid.", {
        path: original.path,
      });
    }
  }
  for (const path of targetSet) {
    if (!candidateSeen.has(path) || !originalSeen.has(path)) {
      throw safetyRefusal("Apply rollback journal path sets do not match.", {
        path,
      });
    }
  }
  return journal;
}

function originalsFromJournal(projectRoot, journal) {
  return new Map(
    journal.originals.map((original) => [
      original.path,
      {
        existed: original.existed,
        bytes: Buffer.from(original.content_base64, "base64"),
        mode: original.mode,
        dev: original.dev,
        ino: original.ino,
        sha256: original.sha256,
        absolutePath: assertInsideRoot(projectRoot, original.path),
        relativePath: original.path,
      },
    ]),
  );
}

async function candidatesMatch(projectRoot, journal) {
  for (const candidate of journal.candidates) {
    const absolutePath = assertInsideRoot(projectRoot, candidate.path);
    let bytes;
    try {
      ({ bytes } = await readRegularFileNoFollow(absolutePath, candidate.path));
    } catch {
      return false;
    }
    if (sha256Hex(bytes) !== candidate.sha256) {
      return false;
    }
  }
  return true;
}

async function readJournal(paths, context) {
  const [bodyState, digestState] = await Promise.allSettled([
    stat(paths.journal),
    stat(paths.journalDigest),
  ]);
  const bodyExists = bodyState.status === "fulfilled";
  const digestExists = digestState.status === "fulfilled";
  if (!bodyExists || !digestExists) {
    if (!bodyExists && !digestExists) {
      const error = new Error("Apply rollback journal is absent.");
      error.code = "ENOENT";
      throw error;
    }
    throw safetyRefusal("Apply rollback journal body/digest pair is incomplete.");
  }
  const journal = await readCanonicalJsonlWithSidecar(
    paths.journal,
    paths.journalDigest,
    "Apply rollback journal",
  );
  return validateJournal(journal, context);
}

async function recoverClaimedStaleApply({ stateDir, runId, projectRoot, paths }) {
  const { state } = await readRunState(stateDir, runId);
  await assertArtifactRoot(stateDir, runId, state.artifact_root);
  const journal = await readJournal(paths, {
    runId,
    projectRoot,
    receiptSha256: state.receipt_sha256,
  }).catch(async (error) => {
    if (error?.code === "ENOENT") {
      await removeLock(paths.lock);
      return null;
    }
    throw error;
  });
  if (journal === null) {
    return { recovered: "lock_without_journal", terminal: false };
  }

  if (state.lifecycle_state === "applied") {
    if (await candidatesMatch(journal.project_path, journal)) {
      await cleanupTerminal(paths);
      return { recovered: "already_applied", terminal: true };
    }
    throw safetyRefusal(
      "Applied run has stale journal but candidate hashes do not match; manual investigation required.",
      { run_id: runId },
    );
  }

  if (state.lifecycle_state !== "approved") {
    throw safetyRefusal("Stale apply recovery requires approved or applied state.", {
      lifecycle_state: state.lifecycle_state,
    });
  }

  const originals = originalsFromJournal(journal.project_path, journal);
  const restoration = await restoreOriginalBytes(originals);
  const restoredSnapshot = await createProjectSnapshot(journal.project_path);
  await markRolledBack(stateDir, runId, {
    source_snapshot_sha256: restoredSnapshot.sha256,
    receipt_sha256: journal.receipt_sha256,
    approval_sha256: state.approval_sha256,
  });
  await cleanupTerminal(paths);
  return { recovered: "rolled_back", terminal: true, ...restoration };
}

export async function applyEvidenceBundle(options) {
  const {
    projectRoot,
    stateDir,
    runId,
    approvalSha256,
    verifier,
  } = options;
  if (typeof verifier !== "function") {
    throw usageError("Apply requires an injected verifier callback.");
  }
  if (
    Object.hasOwn(options, "staleLockMs") ||
    Object.hasOwn(options, "heartbeatIntervalMs")
  ) {
    throw usageError("Apply lock heartbeat/lease options are unsupported.");
  }

  const root = resolve(projectRoot);
  await assertSafeStateDir(stateDir);
  let { state } = await readRunState(stateDir, runId);
  await assertArtifactRoot(stateDir, runId, state.artifact_root);
  const acquired = await acquireApplyLock(stateDir, runId, root);
  if (acquired.terminal) {
    throw safetyRefusal("Stale apply recovery reached terminal state.", {
      recovered: acquired.terminal.recovered,
    });
  }

  const { paths, ownerToken } = acquired;
  let originals;
  let observedReceipt;
  let stateApplied = false;
  try {
    ({ state } = await readRunState(stateDir, runId));
    await assertArtifactRoot(stateDir, runId, state.artifact_root);
    const evidence = await readEvidenceBundle(state.artifact_root);
    if (evidence.receipt.run_id !== state.run_id) {
      throw safetyRefusal("Receipt run id does not match run state.", {
        receipt_run_id: evidence.receipt.run_id,
        state_run_id: state.run_id,
      });
    }
    for (const field of [
      "manifest_sha256",
      "workflow_plan_sha256",
      "source_snapshot_sha256",
    ]) {
      if (evidence.receipt[field] !== state[field]) {
        throw safetyRefusal(`Receipt field '${field}' does not match run state.`, {
          field,
        });
      }
    }
    if (
      state.receipt_sha256 &&
      state.receipt_sha256 !== evidence.receipt_sha256
    ) {
      throw safetyRefusal("Stored receipt hash does not match evidence receipt.", {
        expected_sha256: state.receipt_sha256,
        actual_sha256: evidence.receipt_sha256,
      });
    }
    if (approvalSha256 !== evidence.receipt_sha256) {
      throw safetyRefusal("Apply approval must exactly match receipt SHA-256.", {
        expected_sha256: evidence.receipt_sha256,
        actual_sha256: approvalSha256 ?? null,
      });
    }

    const currentSnapshot = await createProjectSnapshot(root);
    if (currentSnapshot.sha256 !== evidence.receipt.source_snapshot_sha256) {
      throw safetyRefusal("Source tree is stale before apply.", {
        expected_sha256: evidence.receipt.source_snapshot_sha256,
        actual_sha256: currentSnapshot.sha256,
      });
    }

    const targets = await normalizeDeclaredChanges(root, evidence.result);
    observedReceipt = {
      source_snapshot_sha256: currentSnapshot.sha256,
      receipt_sha256: evidence.receipt_sha256,
      approval_sha256: approvalSha256,
    };

    if (state.lifecycle_state === "receipted") {
      await advanceStoredRunState(
        stateDir,
        runId,
        {
          lifecycle_state: "approved",
          approval_sha256: approvalSha256,
        },
        {
          observed: {
            source_snapshot_sha256: currentSnapshot.sha256,
            receipt_sha256: evidence.receipt_sha256,
          },
        },
      );
    } else if (state.lifecycle_state === "approved") {
      if (state.approval_sha256 !== approvalSha256) {
        throw safetyRefusal(
          "Stored approval hash does not match supplied approval.",
          {
            expected_sha256: state.approval_sha256,
            actual_sha256: approvalSha256,
          },
        );
      }
    } else {
      throw safetyRefusal("Apply requires a receipted or approved run state.", {
        lifecycle_state: state.lifecycle_state,
      });
    }

    originals = await captureOriginalBytes(targets);
    await options.onAfterCapture?.();
    const capturedSnapshot = await createProjectSnapshot(root);
    if (capturedSnapshot.sha256 !== evidence.receipt.source_snapshot_sha256) {
      throw safetyRefusal("Source tree changed during original capture.", {
        expected_sha256: evidence.receipt.source_snapshot_sha256,
        actual_sha256: capturedSnapshot.sha256,
      });
    }
    const journal = journalFromOriginals({
      runId,
      projectRoot: root,
      receiptSha256: evidence.receipt_sha256,
      targets,
      originals,
    });
    await writeCanonicalJsonlWithSidecar(paths.journal, paths.journalDigest, journal);

    let mutationIndex = 0;
    for (const target of targets) {
      await safeReplaceFile(
        { ...target, expectedOriginal: originals.get(target.relativePath) },
        target.bytes,
      );
      mutationIndex += 1;
      await options.onAfterMutation?.({
        mutationIndex,
        path: target.relativePath,
      });
    }

    let verifierResult;
    try {
      verifierResult = await verifier({
        projectRoot: root,
        changed_paths: targets.map((target) => target.relativePath),
        receipt: evidence.receipt,
      });
    } catch (error) {
      throw verifierFailure("Verifier callback threw during apply.", {}, error);
    }
    if (verifierResult !== true) {
      throw verifierFailure("Verifier callback did not approve applied candidate.", {
        verifier_result: verifierResult,
      });
    }

    const applied = await advanceStoredRunState(
      stateDir,
      runId,
      { lifecycle_state: "applied" },
      { observed: observedReceipt },
    );
    stateApplied = true;
    await cleanupJournal(paths);
    await removeOwnedLock(paths.lock, "apply", runId, ownerToken);
    return Object.freeze({
      state: applied.state,
      receipt_sha256: evidence.receipt_sha256,
      changed_paths: targets.map((target) => target.relativePath),
    });
  } catch (error) {
    if (stateApplied) {
      throw error;
    }
    if (originals === undefined) {
      await removeOwnedLock(paths.lock, "apply", runId, ownerToken).catch(
        (releaseError) => {
          if (releaseError?.code !== "ENOENT") {
            throw releaseError;
          }
        },
      );
      throw error;
    }
    const restoration = await restoreOriginalBytes(originals);
    await markRolledBack(stateDir, runId, observedReceipt);
    await cleanupJournal(paths);
    await removeOwnedLock(paths.lock, "apply", runId, ownerToken);
    if (error instanceof VerificationRollbackError) {
      throw new VerificationRollbackError(
        error.message,
        { ...error.details, ...restoration },
        error.cause,
      );
    }
    throw new VerificationRollbackError(
      "Apply failed and original bytes were restored.",
      restoration,
      error,
    );
  }
}
