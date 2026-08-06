import { lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertAdaptiveInputMatchesLaunch,
  validateAdaptiveSessionLaunch,
} from "../contracts/adaptive-session-launch.js";
import { notFound, safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import { readRegularFileNoFollow } from "./snapshot.js";

const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw safetyRefusal("sessionId must be a path-safe identifier.");
  }
  return sessionId;
}

function pairPaths(directory, name) {
  return Object.freeze({
    body: join(directory, `${name}.jsonl`),
    digest: join(directory, `${name}.sha256`),
  });
}

export function adaptiveSessionLaunchPaths(pathsOrStateDir, sessionId = undefined) {
  const root = sessionId === undefined
    ? (typeof pathsOrStateDir === "string" ? pathsOrStateDir : pathsOrStateDir.root)
    : join(resolve(pathsOrStateDir), "sessions", validateSessionId(sessionId));
  return Object.freeze({
    root,
    launch: pairPaths(root, "launch"),
    input: pairPaths(root, "input"),
    attempts: join(root, "attempts"),
    body: join(root, "launch.jsonl"),
    digest: join(root, "launch.sha256"),
  });
}

async function assertRealSessionRoot(root) {
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal("Adaptive session artifact root must be a real directory.");
  }
}

function persistedLaunchError(error) {
  if (error?.code === "usage_error") {
    return safetyRefusal("Adaptive session launch contract is not valid authority.", {
      cause: error.message,
    });
  }
  return error;
}

async function launchPairExists(paths) {
  const existence = await Promise.all([paths.body, paths.digest].map(async (path) =>
    lstat(path).then((stats) => {
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw safetyRefusal("Adaptive launch artifact pair must be regular files.");
      }
      return true;
    }).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })));
  if (existence[0] !== existence[1]) {
    throw safetyRefusal("Adaptive launch artifact pair is incomplete.");
  }
  return existence[0];
}

export async function writeAdaptiveSessionLaunch(paths, launch) {
  await assertRealSessionRoot(paths.root);
  const launchPaths = adaptiveSessionLaunchPaths(paths).launch;
  if (await launchPairExists(launchPaths)) {
    throw safetyRefusal("Adaptive session launch already exists.");
  }
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  const line = canonicalJSONLine(frozenLaunch);
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  try {
    await writeFile(launchPaths.body, line, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(launchPaths.digest, `${sha256}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw safetyRefusal("Adaptive session launch already exists.");
    }
    throw error;
  }
  return Object.freeze({ launch: frozenLaunch, sha256 });
}

export async function readAdaptiveSessionLaunch(paths, options = {}) {
  await assertRealSessionRoot(paths.root);
  const launchPaths = adaptiveSessionLaunchPaths(paths).launch;
  if (!await launchPairExists(launchPaths)) {
    if (options.required === false) return null;
    throw notFound("Adaptive session launch does not exist.");
  }
  const [body, digest] = await Promise.all([
    readRegularFileNoFollow(launchPaths.body, "Adaptive session launch body"),
    readRegularFileNoFollow(launchPaths.digest, "Adaptive session launch digest"),
  ]);
  const line = body.bytes.toString("utf8");
  const digestLine = digest.bytes.toString("utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal("Adaptive session launch must be exactly one JSON line.");
  }
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal("Adaptive session launch digest must be one lowercase SHA-256 line.");
  }
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (sha256 !== digestLine.slice(0, -1)) {
    throw safetyRefusal("Adaptive session launch digest mismatch.");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal("Adaptive session launch JSON is malformed.");
  }
  if (sha256Hex(canonicalJSONLineBytes(value)) !== sha256) {
    throw safetyRefusal("Adaptive session launch is not canonical JSONL.");
  }
  try {
    return Object.freeze({
      launch: validateAdaptiveSessionLaunch(value),
      sha256,
    });
  } catch (error) {
    throw persistedLaunchError(error);
  }
}

export async function readBoundAdaptiveSessionLaunch(paths, input, options = {}) {
  const stored = await readAdaptiveSessionLaunch(paths, {
    required: false,
  });
  if (input.launch_sha256 === undefined) {
    if (options.requireBinding === true) {
      throw safetyRefusal("Adaptive session input is not bound to its launch contract.");
    }
    if (stored !== null) {
      throw safetyRefusal("Adaptive launch cannot authorize execution without input binding.");
    }
    return null;
  }
  if (stored === null) {
    throw safetyRefusal("Adaptive session input references a missing launch contract.");
  }
  if (stored.sha256 !== input.launch_sha256) {
    throw safetyRefusal("Adaptive session launch digest does not match frozen input.");
  }
  try {
    assertAdaptiveInputMatchesLaunch(input, stored.launch);
  } catch (error) {
    throw persistedLaunchError(error);
  }
  return stored;
}

async function readCanonicalPairValue(paths, label) {
  const [body, digest] = await Promise.all([
    readRegularFileNoFollow(paths.body, `${label} body`),
    readRegularFileNoFollow(paths.digest, `${label} digest`),
  ]);
  const line = body.bytes.toString("utf8");
  const digestLine = digest.bytes.toString("utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal(`${label} must be exactly one JSON line.`);
  }
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(`${label} digest must be one lowercase SHA-256 line.`);
  }
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (sha256 !== digestLine.slice(0, -1)) {
    throw safetyRefusal(`${label} digest mismatch.`);
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal(`${label} JSON is malformed.`);
  }
  if (sha256Hex(canonicalJSONLineBytes(value)) !== sha256) {
    throw safetyRefusal(`${label} is not canonical JSONL.`);
  }
  return value;
}

export async function readAdaptiveSessionLaunchForResume(stateDir, sessionId) {
  const paths = adaptiveSessionLaunchPaths(stateDir, sessionId);
  await assertRealSessionRoot(paths.root);
  const inputExists = await launchPairExists(paths.input);
  if (!inputExists) {
    throw safetyRefusal("Adaptive launch contract is not bound to adaptive input.");
  }
  const input = await readCanonicalPairValue(paths.input, "Adaptive session input");
  const stored = await readBoundAdaptiveSessionLaunch(paths, input, {
    requireBinding: true,
  });
  if (stored === null) {
    throw safetyRefusal("Adaptive session has no launch contract bound for resume.");
  }
  return stored;
}
