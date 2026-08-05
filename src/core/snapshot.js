import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".harness",
  "node_modules",
  "build",
  "target",
  "dist",
]);

const SECRET_FILE_PATTERN =
  /(^|[._-])(secret|secrets|credential|credentials|token|tokens|key|keys|api[_-]?key|private[_-]?key)($|[._-])/i;

function toPosixPath(path) {
  return path.split(sep).join("/");
}

export function compareCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertInsideRoot(rootPath, candidatePath) {
  const root = resolve(rootPath);
  const candidate = resolve(root, candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw safetyRefusal("Path escapes project root.", {
      root,
      path: candidatePath,
    });
  }
  return candidate;
}

export function normalizeRelativePath(rootPath, path) {
  if (typeof path !== "string" || path.length === 0) {
    throw usageError("Relative path must be a non-empty string.", { path });
  }
  if (path.includes("\0") || path.includes("\\")) {
    throw safetyRefusal("Relative path contains unsupported characters.", {
      path,
    });
  }
  if (isAbsolute(path)) {
    throw safetyRefusal("Relative path must not be absolute.", { path });
  }

  const absolute = assertInsideRoot(rootPath, path);
  const relativePath = toPosixPath(relative(resolve(rootPath), absolute));
  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith("../") ||
    relativePath === ".."
  ) {
    throw safetyRefusal("Relative path must point inside project root.", {
      path,
    });
  }
  return relativePath;
}

export function isExcludedRelativePath(relativePath) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1) ?? "";
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) {
    return true;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  return SECRET_FILE_PATTERN.test(basename);
}

async function readAdmittedFile(rootPath, relativePath) {
  if (isExcludedRelativePath(relativePath)) {
    throw safetyRefusal("Path is excluded from harness scope.", {
      path: relativePath,
    });
  }

  const absolute = assertInsideRoot(rootPath, relativePath);
  const { stats, bytes } = await readRegularFileNoFollow(
    absolute,
    relativePath,
  );
  return {
    path: relativePath,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

async function walk(rootPath, directoryRelativePath, entries) {
  const directoryAbsolutePath = assertInsideRoot(rootPath, directoryRelativePath);
  const names = await readdir(directoryAbsolutePath);
  for (const name of names.sort(compareCodeUnit)) {
    const relativePath =
      directoryRelativePath === "" ? name : `${directoryRelativePath}/${name}`;
    if (isExcludedRelativePath(relativePath)) {
      continue;
    }

    const absolutePath = assertInsideRoot(rootPath, relativePath);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw safetyRefusal("Symlinks are refused in admitted harness scope.", {
        path: relativePath,
      });
    }
    if (stats.isDirectory()) {
      await walk(rootPath, relativePath, entries);
      continue;
    }
    if (!stats.isFile()) {
      throw safetyRefusal("Only regular files are admitted in harness scope.", {
        path: relativePath,
      });
    }

    const { bytes } = await readRegularFileNoFollow(absolutePath, relativePath);
    entries.push({
      path: relativePath,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }
}

export async function readRegularFileNoFollow(absolutePath, relativePath) {
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink()) {
    throw safetyRefusal("Symlinks are refused in admitted harness scope.", {
      path: relativePath,
    });
  }
  if (!before.isFile()) {
    throw safetyRefusal("Only regular files are admitted in harness scope.", {
      path: relativePath,
    });
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(absolutePath, flags);
    const openStats = await handle.stat();
    if (!openStats.isFile()) {
      throw safetyRefusal("Only regular files are admitted in harness scope.", {
        path: relativePath,
      });
    }
    if (openStats.dev !== before.dev || openStats.ino !== before.ino) {
      throw safetyRefusal("File identity changed during snapshot read.", {
        path: relativePath,
      });
    }
    const bytes = await handle.readFile();
    const after = await lstat(absolutePath);
    if (
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw safetyRefusal("File identity changed during snapshot read.", {
        path: relativePath,
      });
    }
    return { stats: openStats, bytes };
  } finally {
    await handle?.close();
  }
}

export async function createProjectSnapshot(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  const paths = options.paths;
  const entries = [];

  if (paths === undefined) {
    await walk(root, "", entries);
  } else {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw usageError("Snapshot paths must be a non-empty array.");
    }
    const normalized = [
      ...new Set(paths.map((path) => normalizeRelativePath(root, path))),
    ];
    for (const relativePath of normalized.sort(compareCodeUnit)) {
      entries.push(await readAdmittedFile(root, relativePath));
    }
  }

  entries.sort((left, right) => compareCodeUnit(left.path, right.path));
  const tree = {
    schema_version: { major: 1 },
    entries,
  };
  const sha256 = sha256Hex(canonicalJSONBytes(tree));
  return Object.freeze({
    ...tree,
    sha256,
  });
}
