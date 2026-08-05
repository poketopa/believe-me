import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateRunState } from "../contracts/run-state.js";
import { safetyRefusal } from "../contracts/errors.js";
import { canonicalJSONLine } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import { advanceRunState } from "./lifecycle.js";

const STATE_FILE = "state.jsonl";
const DIGEST_FILE = "state.sha256";
const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/;

export function runStatePath(stateDir, runId) {
  return join(stateDir, "runs", runId, STATE_FILE);
}

export function runStateDigestPath(stateDir, runId) {
  return join(stateDir, "runs", runId, DIGEST_FILE);
}

async function atomicWriteFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function writeRunState(stateDir, state) {
  const validated = validateRunState(state, { persisted: true });
  const line = canonicalJSONLine(validated);
  const digest = sha256Hex(Buffer.from(line, "utf8"));
  await atomicWriteFile(runStatePath(stateDir, validated.run_id), line);
  await atomicWriteFile(
    runStateDigestPath(stateDir, validated.run_id),
    `${digest}\n`,
  );
  return { state: validated, sha256: digest };
}

export async function readRunState(stateDir, runId) {
  const [line, digestLine] = await Promise.all([
    readFile(runStatePath(stateDir, runId), "utf8"),
    readFile(runStateDigestPath(stateDir, runId), "utf8"),
  ]);

  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal("Persisted run state must be exactly one JSON line.");
  }

  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(
      "Persisted run state digest must be exactly one lowercase SHA-256 line.",
    );
  }

  const actualDigest = sha256Hex(Buffer.from(line, "utf8"));
  const expectedDigest = digestLine.slice(0, -1);
  if (actualDigest !== expectedDigest) {
    throw safetyRefusal("Persisted run state digest mismatch.", {
      expected_sha256: expectedDigest,
      actual_sha256: actualDigest,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw safetyRefusal("Persisted run state JSON is malformed.");
  }

  return {
    state: validateRunState(parsed, { persisted: true }),
    sha256: actualDigest,
  };
}

function assertObservedHash(field, expected, observed) {
  if (observed === undefined) {
    throw safetyRefusal(`Resume revalidation requires observed '${field}'.`, {
      field,
    });
  }

  if (observed !== expected) {
    throw safetyRefusal(`Resume revalidation mismatch for '${field}'.`, {
      field,
      expected_sha256: expected,
      observed_sha256: observed,
    });
  }
}

export function assertResumeRevalidation(state, options = {}) {
  const observed = options.observed ?? {};

  assertObservedHash(
    "source_snapshot_sha256",
    state.source_snapshot_sha256,
    observed.source_snapshot_sha256,
  );

  for (const field of ["receipt_sha256", "approval_sha256"]) {
    if (Object.hasOwn(state, field)) {
      assertObservedHash(field, state[field], observed[field]);
    }
  }
}

export async function advanceStoredRunState(stateDir, runId, patch, options = {}) {
  const { state } = await readRunState(stateDir, runId);
  assertResumeRevalidation(state, options);
  return writeRunState(stateDir, advanceRunState(state, patch));
}
