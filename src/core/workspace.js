import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import {
  assertInsideRoot,
  createProjectSnapshot,
  isExcludedRelativePath,
  normalizeRelativePath,
  readRegularFileNoFollow,
} from "./snapshot.js";
import { sha256Hex } from "./hash.js";

async function assertDirectoryRoot(path, label) {
  const absolute = resolve(path);
  const stats = await lstat(absolute).catch((error) => {
    throw usageError(`${label} must be an existing directory.`, {
      path: absolute,
      cause_code: error.code,
    });
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal(`${label} must be a non-symlink directory.`, {
      path: absolute,
    });
  }
  return absolute;
}

async function ensureSafeParentDirectories(
  workspaceRoot,
  relativePath,
  { createMissing = true } = {},
) {
  const parent = dirname(relativePath);
  if (parent === ".") {
    return;
  }
  let current = workspaceRoot;
  for (const segment of parent.split("/")) {
    current = join(current, segment);
    let stats = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (stats === null) {
      if (!createMissing) {
        throw safetyRefusal("Declared candidate parent is missing from workspace.", {
          path: current,
        });
      }
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw safetyRefusal(
        "Workspace path must contain only real directories.",
        { path: current },
      );
    }
  }
}

async function writeWorkspaceFile(workspaceRoot, relativePath, bytes, mode) {
  const destination = assertInsideRoot(workspaceRoot, relativePath);
  await ensureSafeParentDirectories(workspaceRoot, relativePath);
  const temporary = join(
    dirname(destination),
    `.${relativePath.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, bytes, { flag: "wx", mode });
  try {
    await rename(temporary, destination);
    await chmod(destination, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function assertDeterministicResultMatchesWorkspace(options) {
  const { workspaceRoot, result, sourceSnapshot } = options;
  const root = await assertDirectoryRoot(workspaceRoot, "workspaceRoot");
  for (const change of result.changes) {
    const relativePath = normalizeRelativePath(root, change.path);
    if (isExcludedRelativePath(relativePath)) {
      throw safetyRefusal("Candidate result targets an excluded path.", {
        path: relativePath,
      });
    }
    await ensureSafeParentDirectories(root, relativePath, { createMissing: false });
    const absolutePath = assertInsideRoot(root, relativePath);
    let bytes;
    try {
      ({ bytes } = await readRegularFileNoFollow(absolutePath, relativePath));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw safetyRefusal("Declared candidate is missing from workspace.", {
          path: relativePath,
        });
      }
      throw error;
    }
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== change.sha256) {
      throw safetyRefusal("Declared candidate does not match workspace bytes.", {
        path: relativePath,
        expected_sha256: change.sha256,
        actual_sha256: actualSha256,
      });
    }
  }
  if (sourceSnapshot !== undefined) {
    const workspaceSnapshot = await createProjectSnapshot(root);
    const sourceEntries = new Map(
      sourceSnapshot.entries.map((entry) => [entry.path, entry.sha256]),
    );
    const workspaceEntries = new Map(
      workspaceSnapshot.entries.map((entry) => [entry.path, entry.sha256]),
    );
    const declaredPaths = new Set(result.changes.map((change) => change.path));

    for (const [path, sourceSha256] of sourceEntries) {
      if (declaredPaths.has(path)) {
        continue;
      }
      if (workspaceEntries.get(path) !== sourceSha256) {
        throw safetyRefusal("Workspace contains an undeclared source change.", {
          path,
        });
      }
    }
    for (const path of workspaceEntries.keys()) {
      if (!sourceEntries.has(path) && !declaredPaths.has(path)) {
        throw safetyRefusal("Workspace contains an undeclared new file.", {
          path,
        });
      }
    }
  }
  return true;
}

export async function createIsolatedWorkspace(options) {
  const { projectRoot, workspaceRoot, expectedSnapshotSha256 } = options;
  const sourceRoot = await assertDirectoryRoot(projectRoot, "projectRoot");
  const destinationRoot = resolve(workspaceRoot);
  const destinationRelative = relative(sourceRoot, destinationRoot);
  const destinationInsideSource =
    destinationRelative !== "" &&
    destinationRelative !== ".." &&
    !destinationRelative.startsWith(`..${sep}`);

  if (
    destinationRoot === sourceRoot ||
    sourceRoot.startsWith(`${destinationRoot}${sep}`) ||
    (destinationInsideSource &&
      destinationRelative.split(sep)[0] !== ".harness")
  ) {
    throw safetyRefusal(
      "Isolated workspace must be outside admitted source scope.",
      { project_root: sourceRoot, workspace_root: destinationRoot },
    );
  }

  const destinationState = await lstat(destinationRoot).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (destinationState !== null) {
    throw safetyRefusal("Isolated workspace already exists.", {
      workspace_root: destinationRoot,
    });
  }

  const snapshot = await createProjectSnapshot(sourceRoot);
  if (
    expectedSnapshotSha256 !== undefined &&
    snapshot.sha256 !== expectedSnapshotSha256
  ) {
    throw safetyRefusal("Source snapshot changed before workspace creation.", {
      expected_sha256: expectedSnapshotSha256,
      actual_sha256: snapshot.sha256,
    });
  }

  await mkdir(dirname(destinationRoot), { recursive: true, mode: 0o700 });
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  try {
    for (const entry of snapshot.entries) {
      const source = assertInsideRoot(sourceRoot, entry.path);
      const { stats, bytes } = await readRegularFileNoFollow(source, entry.path);
      if (sha256Hex(bytes) !== entry.sha256) {
        throw safetyRefusal("Source file changed while copying workspace.", {
          path: entry.path,
        });
      }
      await writeWorkspaceFile(
        destinationRoot,
        entry.path,
        bytes,
        stats.mode & 0o777,
      );
    }

    const copiedSnapshot = await createProjectSnapshot(destinationRoot);
    if (copiedSnapshot.sha256 !== snapshot.sha256) {
      throw safetyRefusal("Isolated workspace snapshot does not match source.", {
        expected_sha256: snapshot.sha256,
        actual_sha256: copiedSnapshot.sha256,
      });
    }
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    project_root: sourceRoot,
    workspace_root: destinationRoot,
    source_snapshot_sha256: snapshot.sha256,
  });
}

export async function applyDeterministicChanges(options) {
  const { workspaceRoot, executorInput, validateResult } = options;
  if (typeof validateResult !== "function") {
    throw usageError("Deterministic execution requires a result validator.");
  }

  const root = await assertDirectoryRoot(workspaceRoot, "workspaceRoot");
  const declaredResult = validateResult({
    schema_version: { major: 1 },
    run_id: executorInput.run_id,
    executor_kind: "deterministic",
    status: "completed",
    changes: executorInput.input.changes,
  });
  const changes = [];
  for (const change of declaredResult.changes) {
    const relativePath = normalizeRelativePath(root, change.path);
    if (isExcludedRelativePath(relativePath)) {
      throw safetyRefusal("Deterministic change targets an excluded path.", {
        path: relativePath,
      });
    }

    const bytes = Buffer.from(change.content_base64, "base64");
    const existingPath = assertInsideRoot(root, relativePath);
    const existing = await lstat(existingPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw safetyRefusal("Deterministic change target must not be a symlink.", {
        path: relativePath,
      });
    }
    if (existing !== null && !existing.isFile()) {
      throw safetyRefusal("Deterministic change target must be a regular file.", {
        path: relativePath,
      });
    }

    await writeWorkspaceFile(
      root,
      relativePath,
      bytes,
      existing === null ? 0o644 : existing.mode & 0o777,
    );
    const { bytes: written } = await readRegularFileNoFollow(
      existingPath,
      relativePath,
    );
    if (sha256Hex(written) !== change.sha256) {
      throw safetyRefusal("Deterministic candidate digest mismatch after write.", {
        path: relativePath,
      });
    }
    changes.push({
      path: relativePath,
      content_base64: change.content_base64,
      sha256: change.sha256,
    });
  }

  return validateResult({ ...declaredResult, changes });
}
