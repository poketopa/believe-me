import { constants } from "node:fs";
import { link, lstat, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { notFound, safetyRefusal } from "../contracts/errors.js";
import { deepFreeze } from "../contracts/common.js";
import { sha256Hex } from "./hash.js";

async function assertRealDirectoryPath(path, messages) {
  const { root } = parse(path);
  let current = root;
  let currentStats = await lstat(root);
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    currentStats = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") {
        throw notFound(messages.parentMissing, { path });
      }
      throw error;
    });
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) {
      throw safetyRefusal(messages.parentRealDirectory, { path });
    }
  }
  return currentStats;
}

async function assertOpenParentIdentity(path, handle, expected, message) {
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
    throw safetyRefusal(message, { path });
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
      await removePathIfHandleIdentity(
        join(candidate, basename(filePath)),
        handle,
      );
      return;
    }
  }
}

export async function writeAtomicArtifactNoOverwrite(path, bytes, options) {
  if (!Buffer.isBuffer(bytes)) {
    throw safetyRefusal(options.messages.bytesMalformed);
  }
  if (bytes.byteLength > options.maxBytes) {
    throw safetyRefusal(options.messages.exceedsLimit);
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputPath = resolve(cwd, path);
  const parent = dirname(outputPath);
  const parentStats = await assertRealDirectoryPath(parent, options.messages);
  if (
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined
  ) {
    throw safetyRefusal(options.messages.noFollowDirectoryUnsupported);
  }
  const existing = await lstat(outputPath).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing !== null) {
    throw safetyRefusal(options.messages.outputExists, { path: outputPath });
  }
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  ).catch((error) => {
    if (error.code === "ELOOP" || error.code === "ENOTDIR") {
      throw safetyRefusal(options.messages.parentRealDirectory, {
        path: parent,
      });
    }
    throw error;
  });
  await assertOpenParentIdentity(
    parent,
    parentHandle,
    parentStats,
    options.messages.parentIdentityChanged,
  ).catch(async (error) => {
    await parentHandle.close();
    throw error;
  });

  const temporaryPath = resolve(
    parent,
    `.${options.temporaryPrefix}.${process.pid}.${randomUUID()}.tmp`,
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
    await assertOpenParentIdentity(
      parent,
      parentHandle,
      parentStats,
      options.messages.parentIdentityChanged,
    );
    handle = await openTemporary(temporaryPath);
    await assertOpenParentIdentity(
      parent,
      parentHandle,
      parentStats,
      options.messages.parentIdentityChanged,
    );
    await writeBytes(handle, bytes);
    await handle.sync();
    await assertOpenParentIdentity(
      parent,
      parentHandle,
      parentStats,
      options.messages.parentIdentityChanged,
    );
    publishing = true;
    await publishLink(temporaryPath, outputPath);
    await assertOpenParentIdentity(
      parent,
      parentHandle,
      parentStats,
      options.messages.parentIdentityChanged,
    );
    published = true;
    return deepFreeze({
      output_path: outputPath,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
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
      throw safetyRefusal(options.messages.outputExists, {
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

async function boundedRead(handle, maxBytes, exceedsLimitMessage) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const length = Math.min(64 * 1024, maxBytes + 1 - total);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw safetyRefusal(exceedsLimitMessage);
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedRegularFileNoFollow(path, options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const inputPath = resolve(cwd, path);
  const before = await lstat(inputPath).catch((error) => {
    if (error.code === "ENOENT") {
      throw notFound(options.messages.missing, { path: inputPath });
    }
    throw error;
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw safetyRefusal(options.messages.regularFile, { path: inputPath });
  }
  if (before.size > options.maxBytes) {
    throw safetyRefusal(options.messages.exceedsLimit);
  }
  if (options.validateStats !== undefined) {
    options.validateStats(before, inputPath);
  }
  if (constants.O_NOFOLLOW === undefined) {
    throw safetyRefusal(options.messages.noFollowFileUnsupported);
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
      throw safetyRefusal(options.messages.identityChanged, {
        path: inputPath,
      });
    }
    if (opened.size > options.maxBytes) {
      throw safetyRefusal(options.messages.exceedsLimit);
    }
    if (options.validateStats !== undefined) {
      options.validateStats(opened, inputPath);
    }
    const bytes = await boundedRead(
      handle,
      options.maxBytes,
      options.messages.exceedsLimit,
    );
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
      throw safetyRefusal(options.messages.identityChanged, {
        path: inputPath,
      });
    }
    if (options.validateStats !== undefined) {
      options.validateStats(after, inputPath);
    }
    return { input_path: inputPath, stats: opened, bytes };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw notFound(options.messages.missing, { path: inputPath });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
