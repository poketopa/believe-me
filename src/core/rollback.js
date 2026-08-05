import { constants } from "node:fs";
import { chmod, open, lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { safetyRefusal } from "../contracts/errors.js";
import { sha256Hex } from "./hash.js";
import { compareCodeUnit } from "./snapshot.js";

export class VerificationRollbackError extends Error {
  constructor(message, details = {}, cause = undefined) {
    super(message, { cause });
    this.name = "VerificationRollbackError";
    this.code = "verification_failed";
    this.details = Object.freeze({ ...details });
    this.exitCode = 5;
  }
}

function identity(stats) {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertSafeParent(parentPath, relativePath) {
  const stats = await lstat(parentPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal("Apply requires an existing safe parent directory.", {
      path: relativePath,
    });
  }
  return identity(stats);
}

async function readTargetMetadata(absolutePath, relativePath) {
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
    return { ...identity(stats), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readExistingSafeFile(absolutePath, relativePath) {
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink()) {
    throw safetyRefusal("Apply refuses symlink targets.", {
      path: relativePath,
    });
  }
  if (!before.isFile()) {
    throw safetyRefusal("Apply only mutates regular file targets.", {
      path: relativePath,
    });
  }
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identity(opened), identity(before))) {
      throw safetyRefusal("Target identity changed during original capture.", {
        path: relativePath,
      });
    }
    const bytes = await handle.readFile();
    const after = await lstat(absolutePath);
    if (after.isSymbolicLink() || !sameIdentity(identity(after), identity(before))) {
      throw safetyRefusal("Target identity changed during original capture.", {
        path: relativePath,
      });
    }
    return {
      bytes,
      mode: before.mode & 0o777,
      dev: before.dev,
      ino: before.ino,
    };
  } finally {
    await handle?.close();
  }
}

async function assertTargetIdentity(absolutePath, relativePath, expected) {
  const actual = await readTargetMetadata(absolutePath, relativePath);
  if (expected === null || actual === null) {
    if (expected !== actual) {
      throw safetyRefusal("Target identity changed before replacement.", {
        path: relativePath,
      });
    }
    return;
  }
  if (!sameIdentity(actual, expected)) {
    throw safetyRefusal("Target identity changed before replacement.", {
      path: relativePath,
    });
  }
}

async function assertExpectedOriginal(target, expectedOriginal) {
  if (expectedOriginal === undefined) {
    return;
  }
  if (!expectedOriginal.existed) {
    const actual = await readTargetMetadata(target.absolutePath, target.relativePath);
    if (actual !== null) {
      throw safetyRefusal("Target appeared after original capture.", {
        path: target.relativePath,
      });
    }
    return;
  }
  const { bytes, mode, dev, ino } = await readExistingSafeFile(
    target.absolutePath,
    target.relativePath,
  );
  if (
    dev !== expectedOriginal.dev ||
    ino !== expectedOriginal.ino ||
    mode !== expectedOriginal.mode ||
    sha256Hex(bytes) !== expectedOriginal.sha256
  ) {
    throw safetyRefusal("Target changed after original capture.", {
      path: target.relativePath,
    });
  }
}

async function fsyncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function safeReplaceFile(target, bytes) {
  const parentPath = dirname(target.absolutePath);
  const beforeParent = await assertSafeParent(parentPath, target.relativePath);
  const beforeTarget = await readTargetMetadata(
    target.absolutePath,
    target.relativePath,
  );
  const mode = target.mode ?? beforeTarget?.mode ?? 0o644;
  const tmpPath = join(
    parentPath,
    `.${target.relativePath.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle;
  try {
    handle = await open(
      tmpPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const afterParent = await assertSafeParent(parentPath, target.relativePath);
    if (!sameIdentity(afterParent, beforeParent)) {
      throw safetyRefusal("Parent directory identity changed before replacement.", {
        path: target.relativePath,
      });
    }
    await assertTargetIdentity(
      target.absolutePath,
      target.relativePath,
      beforeTarget,
    );
    await assertExpectedOriginal(target, target.expectedOriginal);
    await rename(tmpPath, target.absolutePath);
    await chmod(target.absolutePath, mode);
    await fsyncDirectory(parentPath);
  } catch (error) {
    await handle?.close();
    await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function captureOriginalBytes(targets) {
  const originals = new Map();
  for (const target of targets) {
    await assertSafeParent(dirname(target.absolutePath), target.relativePath);
    try {
      const { bytes, mode, dev, ino } = await readExistingSafeFile(
        target.absolutePath,
        target.relativePath,
      );
      originals.set(target.relativePath, {
        existed: true,
        bytes,
        mode,
        dev,
        ino,
        sha256: sha256Hex(bytes),
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      originals.set(target.relativePath, {
        existed: false,
        bytes: Buffer.alloc(0),
        mode: null,
        dev: null,
        ino: null,
        sha256: null,
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
      });
    }
  }
  return originals;
}

export async function restoreOriginalBytes(originals) {
  for (const original of [...originals.values()].reverse()) {
    if (original.existed) {
      await safeReplaceFile(original, original.bytes);
    } else {
      await rm(original.absolutePath, { force: true });
      await fsyncDirectory(dirname(original.absolutePath));
    }
  }

  for (const [relativePath, original] of originals) {
    if (original.existed) {
      const restored = await readFile(original.absolutePath);
      const restoredSha256 = sha256Hex(restored);
      if (restoredSha256 !== original.sha256) {
        throw safetyRefusal("Rollback restoration proof failed.", {
          path: relativePath,
          expected_sha256: original.sha256,
          actual_sha256: restoredSha256,
        });
      }
    } else {
      try {
        await lstat(original.absolutePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      throw safetyRefusal("Rollback restoration proof failed.", {
        path: relativePath,
        expected_absent: true,
      });
    }
  }

  return Object.freeze({
    restored_paths: [...originals.keys()].sort(compareCodeUnit),
  });
}
