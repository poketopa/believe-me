import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateHermeticBoundary,
} from "../contracts/hermetic-boundary.js";
import { notFound, safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import { runDirectory } from "./run-artifacts.js";
import { readRegularFileNoFollow } from "./snapshot.js";

const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw safetyRefusal("runId must be a path-safe identifier.");
  }
  return runId;
}

export function hermeticBoundaryPaths(stateDir, runId) {
  const inputs = join(runDirectory(stateDir, validateRunId(runId)), "inputs");
  return Object.freeze({
    root: inputs,
    body: join(inputs, "hermetic-boundary.jsonl"),
    digest: join(inputs, "hermetic-boundary.jsonl.sha256"),
  });
}

async function assertRealDirectory(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal(`${label} must be a real directory.`);
  }
}

async function ensureRealDirectory(path, label) {
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await assertRealDirectory(path, label);
}

async function pairExists(paths) {
  const exists = await Promise.all([paths.body, paths.digest].map(async (path) =>
    lstat(path).then((stats) => {
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw safetyRefusal("Hermetic boundary body/digest pair must be regular files.");
      }
      return true;
    }).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })));
  if (exists[0] !== exists[1]) {
    throw safetyRefusal("Hermetic boundary body/digest pair is incomplete.");
  }
  return exists[0];
}

function persistedBoundaryError(error) {
  if (error?.code === "usage_error" || error?.code === "persisted_schema_unsupported") {
    return safetyRefusal("Persisted hermetic boundary is not valid authority.", {
      cause_code: error.code,
      cause: error.message,
    });
  }
  return error;
}

export async function writeHermeticBoundary({ stateDir, runId, boundary }) {
  const frozen = validateHermeticBoundary(boundary);
  const paths = hermeticBoundaryPaths(stateDir, runId);
  await assertRealDirectory(runDirectory(stateDir, runId), "Run artifact root");
  await ensureRealDirectory(paths.root, "Frozen run input root");
  if (await pairExists(paths)) {
    throw safetyRefusal("Hermetic boundary already exists.");
  }
  const line = canonicalJSONLine(frozen);
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  try {
    await writeFile(paths.body, line, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(paths.digest, `${sha256}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw safetyRefusal("Hermetic boundary already exists.");
    }
    throw error;
  }
  return Object.freeze({ boundary: frozen, sha256 });
}

export async function readHermeticBoundary(stateDir, runId, options = {}) {
  const paths = hermeticBoundaryPaths(stateDir, runId);
  await assertRealDirectory(runDirectory(stateDir, runId), "Run artifact root");
  await assertRealDirectory(paths.root, "Frozen run input root");
  if (!await pairExists(paths)) {
    if (options.required === true) {
      throw notFound("Hermetic boundary does not exist.");
    }
    return null;
  }
  const [body, digest] = await Promise.all([
    readRegularFileNoFollow(paths.body, "Hermetic boundary body"),
    readRegularFileNoFollow(paths.digest, "Hermetic boundary digest"),
  ]);
  const line = body.bytes.toString("utf8");
  const digestLine = digest.bytes.toString("utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal("Hermetic boundary must be exactly one JSON line.");
  }
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal("Hermetic boundary digest must be one lowercase SHA-256 line.");
  }
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (sha256 !== digestLine.slice(0, -1)) {
    throw safetyRefusal("Hermetic boundary digest mismatch.");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal("Hermetic boundary JSON is malformed.");
  }
  if (sha256Hex(canonicalJSONLineBytes(value)) !== sha256) {
    throw safetyRefusal("Hermetic boundary is not canonical JSONL.");
  }
  try {
    return Object.freeze({
      boundary: validateHermeticBoundary(value, { persisted: true }),
      sha256,
    });
  } catch (error) {
    throw persistedBoundaryError(error);
  }
}

export async function readBoundHermeticBoundary(stateDir, runId, expectedSha256) {
  const stored = await readHermeticBoundary(stateDir, runId);
  if (expectedSha256 === undefined || expectedSha256 === null) {
    if (stored !== null) {
      throw safetyRefusal("Persisted hermetic boundary has no digest binding.");
    }
    return null;
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw safetyRefusal("Hermetic boundary binding must be a lowercase SHA-256 digest.");
  }
  if (stored === null) {
    throw safetyRefusal("Hermetic boundary binding references missing authority.");
  }
  if (stored.sha256 !== expectedSha256) {
    throw safetyRefusal("Hermetic boundary digest does not match its binding.");
  }
  return stored;
}
