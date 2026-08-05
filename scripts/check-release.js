#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const STRICT_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REQUIRED_PUBLISH_FILES = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
const PUBLISH_LIFECYCLE_SCRIPTS = [
  "prepublish",
  "prepare",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
];
const UNSAFE_PACKED_PATHS = [
  /(^|\/)\.env($|[./])/,
  /(^|\/)\.omx($|\/)/,
  /(^|\/)state($|\/)/,
  /(^|\/)build($|\/)/,
  /(^|\/)dist($|\/)/,
  /(^|\/)coverage($|\/)/,
  /(^|\/).+\.tgz$/,
  /(^|\/)npm-debug\.log$/,
];

function parseArgs(argv) {
  const args = {
    tag: null,
    publish: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") {
      args.publish = true;
    } else if (arg === "--tag") {
      args.tag = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown release check argument: ${arg}`);
    }
  }

  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(join(ROOT, path), "utf8"));
}

async function readProduct() {
  const moduleUrl = pathToFileURL(join(ROOT, "src/product.js")).href;
  const imported = await import(`${moduleUrl}?release-check=${Date.now()}`);
  return imported.product;
}

function isWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

async function inspectRepositoryFile(path) {
  const candidate = join(ROOT, path);
  if (!isWithin(ROOT, candidate)) {
    return { path, reason: "outside_root" };
  }

  try {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) {
      return { path, reason: "symbolic_link" };
    }
    if (!stats.isFile()) {
      return { path, reason: "not_regular_file" };
    }

    const [rootRealPath, candidateRealPath] = await Promise.all([
      realpath(ROOT),
      realpath(candidate),
    ]);
    return isWithin(rootRealPath, candidateRealPath)
      ? null
      : { path, reason: "outside_root" };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { path, reason: "missing" };
    }
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function mismatch(field, expected, actual) {
  return {
    code: `${field}_mismatch`,
    field,
    expected,
    actual,
  };
}

function invalidMetadata(field, actual) {
  return {
    code: "metadata_invalid",
    field,
    expected: "non-empty string",
    actual: typeof actual,
  };
}

function unsafePackedPaths(paths) {
  return paths.filter((path) => UNSAFE_PACKED_PATHS.some((pattern) => pattern.test(path)));
}

async function packedFiles() {
  const result = await run("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"]);
  if (result.signal !== null || result.code !== 0) {
    return {
      files: [],
      error: {
        code: "pack_dry_run_failed",
        field: "pack",
        expected: "npm pack --json --dry-run exits 0",
        actual: `exit ${result.code ?? "signal"}${result.stderr ? ": stderr redacted" : ""}`,
      },
    };
  }

  const parsed = JSON.parse(result.stdout);
  const files = parsed[0]?.files?.map((file) => file.path).sort() ?? [];
  return { files, error: null };
}

async function buildResult(args) {
  const packageJson = await readJson("package.json");
  const packageLock = await readJson("package-lock.json");
  const product = await readProduct();
  const lockRoot = packageLock.packages?.[""] ?? {};
  const mode = args.publish ? "publish" : "development";
  const errors = [];

  for (const [field, value] of [
    ["name.package", packageJson.name],
    ["name.lock", lockRoot.name],
    ["name.product", product.name],
    ["version.package", packageJson.version],
    ["version.lockfile", packageLock.version],
    ["version.lock", lockRoot.version],
    ["version.product", product.version],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(invalidMetadata(field, value));
    }
  }

  if (packageJson.name !== lockRoot.name) {
    errors.push(mismatch("name.lock", packageJson.name, lockRoot.name ?? null));
  }
  if (packageJson.name !== product.name) {
    errors.push(mismatch("name.product", packageJson.name, product.name ?? null));
  }
  if (packageJson.version !== packageLock.version) {
    errors.push(mismatch("version.lockfile", packageJson.version, packageLock.version ?? null));
  }
  if (packageJson.version !== lockRoot.version) {
    errors.push(mismatch("version.lock", packageJson.version, lockRoot.version ?? null));
  }
  if (packageJson.version !== product.version) {
    errors.push(mismatch("version.product", packageJson.version, product.version ?? null));
  }

  let tag = null;
  if (args.tag !== null || args.publish) {
    const match = args.tag?.match(STRICT_TAG) ?? null;
    if (match === null) {
      errors.push({
        code: "tag_invalid",
        field: "tag",
        expected: "strict vX.Y.Z",
        actual: args.tag,
      });
    } else {
      tag = {
        input: args.tag,
        version: `${match[1]}.${match[2]}.${match[3]}`,
      };
      if (tag.version !== packageJson.version) {
        errors.push(mismatch("tag.version", packageJson.version, tag.version));
      }
    }
  }

  const missingFiles = [];
  if (args.publish) {
    if (packageJson.private !== false) {
      errors.push({
        code: "private_publish_blocked",
        field: "package.private",
        expected: false,
        actual: packageJson.private ?? null,
      });
    }

    const invalidRequiredFiles = [];
    for (const file of REQUIRED_PUBLISH_FILES) {
      const issue = await inspectRepositoryFile(file);
      if (issue?.reason === "missing") {
        missingFiles.push(file);
      } else if (issue !== null) {
        invalidRequiredFiles.push(issue);
      }
    }
    if (missingFiles.length > 0) {
      errors.push({
        code: "required_files_missing",
        field: "files.required",
        expected: REQUIRED_PUBLISH_FILES,
        actual: missingFiles,
      });
    }
    if (invalidRequiredFiles.length > 0) {
      errors.push({
        code: "required_files_invalid",
        field: "files.required",
        expected: "repository-local regular files",
        actual: invalidRequiredFiles,
      });
    }

    const configuredLifecycleScripts = PUBLISH_LIFECYCLE_SCRIPTS.filter((name) =>
      Object.hasOwn(packageJson.scripts ?? {}, name));
    if (configuredLifecycleScripts.length > 0) {
      errors.push({
        code: "publish_lifecycle_scripts_blocked",
        field: "package.scripts",
        expected: "no npm publish lifecycle scripts",
        actual: configuredLifecycleScripts,
      });
    }
  }

  let pack = {
    checked: false,
    files: [],
    unsafe: [],
  };
  if (args.publish && errors.length === 0) {
    const packed = await packedFiles();
    pack = {
      checked: true,
      files: packed.files,
      unsafe: unsafePackedPaths(packed.files),
    };
    if (packed.error !== null) {
      errors.push(packed.error);
    }
    if (packed.error === null) {
      const missingPackedFiles = REQUIRED_PUBLISH_FILES.filter((file) =>
        !packed.files.includes(file));
      if (missingPackedFiles.length > 0) {
        errors.push({
          code: "required_packed_files_missing",
          field: "pack.files",
          expected: REQUIRED_PUBLISH_FILES,
          actual: missingPackedFiles,
        });
      }

    }
    if (pack.unsafe.length > 0) {
      errors.push({
        code: "unsafe_packed_files",
        field: "pack.files",
        expected: "no env, state, build, coverage, log, or tarball residues",
        actual: pack.unsafe,
      });
    }
  }

  const publishable = args.publish && errors.length === 0;
  return {
    status: errors.length === 0 ? "ok" : "error",
    mode,
    publishable,
    publicationBlocked: !publishable,
    tag,
    metadata: {
      package: {
        name: packageJson.name,
        version: packageJson.version,
        private: packageJson.private === true,
      },
      lock: {
        name: lockRoot.name ?? null,
        version: lockRoot.version ?? null,
        rootVersion: packageLock.version ?? null,
      },
      product: {
        name: product.name ?? null,
        version: product.version ?? null,
      },
    },
    requiredFiles: {
      expected: REQUIRED_PUBLISH_FILES,
      missing: missingFiles,
    },
    pack,
    errors,
  };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildResult(args);
  writeResult(result);
  process.exitCode = result.status === "ok" ? 0 : 1;
} catch (error) {
  writeResult({
    status: "error",
    mode: "unknown",
    publishable: false,
    publicationBlocked: true,
    tag: null,
    metadata: {
      package: null,
      lock: null,
      product: null,
    },
    requiredFiles: {
      expected: REQUIRED_PUBLISH_FILES,
      missing: [],
    },
    pack: {
      checked: false,
      files: [],
      unsafe: [],
    },
    errors: [{
      code: "release_check_failed",
      field: "release",
      expected: "validated release metadata",
      actual: typeof error?.code === "string"
        ? error.code
        : error instanceof Error
          ? error.name
          : "unknown_error",
    }],
  });
  process.exitCode = 1;
}
