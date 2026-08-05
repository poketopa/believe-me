import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import { validateRunSpec } from "../contracts/run-spec.js";
import { validateSkillManifest } from "../contracts/skill-manifest.js";
import { validateWorkflowPlan } from "../contracts/workflow-plan.js";
import { deepFreeze } from "../contracts/common.js";
import { validateContextPack } from "../contracts/context-pack.js";
import {
  validateExecutorInput,
  validateExecutorResult,
} from "../contracts/executor.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256CanonicalJSON, sha256Hex } from "./hash.js";
import { readRegularFileNoFollow } from "./snapshot.js";

const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/;

const INPUT_FILES = Object.freeze({
  manifest: "manifest.jsonl",
  runSpec: "run-spec.jsonl",
  sourceSnapshot: "source-snapshot.jsonl",
  workflowPlan: "workflow-plan.jsonl",
  executorInput: "executor-input.jsonl",
});

export function runDirectory(stateDir, runId) {
  return join(stateDir, "runs", runId);
}

export function runWorkspacePath(stateDir, runId) {
  return join(runDirectory(stateDir, runId), "workspace");
}

export function runArtifactRoot(stateDir, runId) {
  return join(runDirectory(stateDir, runId), "artifacts");
}

function pairPaths(directory, file) {
  return Object.freeze({
    body: join(directory, file),
    digest: join(directory, file.replace(/\.jsonl$/, ".sha256")),
  });
}

export function frozenRunInputPaths(stateDir, runId) {
  const directory = join(runDirectory(stateDir, runId), "inputs");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(INPUT_FILES).map(([key, file]) => [
        key,
        pairPaths(directory, file),
      ]),
    ),
  );
}

export function contextPackArtifactPaths(artifactRoot) {
  return pairPaths(artifactRoot, "context-pack.jsonl");
}

async function writeCanonicalPair(paths, value) {
  const line = canonicalJSONLine(value);
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  await mkdir(dirname(paths.body), { recursive: true, mode: 0o700 });
  await writeFile(paths.body, line, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await writeFile(paths.digest, `${sha256}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw safetyRefusal("Frozen run artifact digest could not be created.", {
      path: paths.digest,
      cause_code: error.code,
    });
  }
  return Object.freeze({ value, sha256 });
}

async function readCanonicalPair(paths, label) {
  const [body, digest] = await Promise.all([
    readRegularFileNoFollow(paths.body, `${label} body`),
    readRegularFileNoFollow(paths.digest, `${label} digest`),
  ]).catch((error) => {
    throw safetyRefusal(`${label} body/digest pair is incomplete.`, {
      cause_code: error.code,
    });
  });
  const line = body.bytes.toString("utf8");
  const digestLine = digest.bytes.toString("utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal(`${label} must be exactly one JSON line.`);
  }
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(`${label} digest must be one lowercase SHA-256 line.`);
  }
  const actualSha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (actualSha256 !== digestLine.slice(0, -1)) {
    throw safetyRefusal(`${label} digest mismatch.`, {
      expected_sha256: digestLine.slice(0, -1),
      actual_sha256: actualSha256,
    });
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal(`${label} JSON is malformed.`);
  }
  if (sha256Hex(canonicalJSONLineBytes(value)) !== actualSha256) {
    throw safetyRefusal(`${label} is not canonical JSONL.`);
  }
  return Object.freeze({ value, sha256: actualSha256 });
}

export async function writeContextPackArtifact(artifactRoot, contextPack) {
  return writeCanonicalPair(
    contextPackArtifactPaths(artifactRoot),
    validateContextPack(contextPack),
  );
}

export async function readContextPackArtifact(artifactRoot) {
  const pair = await readCanonicalPair(
    contextPackArtifactPaths(artifactRoot),
    "ContextPack",
  );
  return Object.freeze({
    value: validateContextPack(pair.value, { persisted: true }),
    sha256: pair.sha256,
  });
}

function validateSourceSnapshot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw safetyRefusal("Persisted source snapshot must be an object.");
  }
  if (value.schema_version?.major !== 1 || !Array.isArray(value.entries)) {
    throw safetyRefusal("Persisted source snapshot schema is unsupported.");
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) {
    throw safetyRefusal("Persisted source snapshot digest is invalid.");
  }
  const paths = new Set();
  let previousPath = null;
  for (const entry of value.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
    ) {
      throw safetyRefusal("Persisted source snapshot entry is invalid.");
    }
    if (paths.has(entry.path) || (previousPath !== null && entry.path < previousPath)) {
      throw safetyRefusal("Persisted source snapshot paths must be unique and sorted.");
    }
    paths.add(entry.path);
    previousPath = entry.path;
  }
  const treeSha256 = sha256CanonicalJSON({
    schema_version: value.schema_version,
    entries: value.entries,
  });
  if (treeSha256 !== value.sha256) {
    throw safetyRefusal("Persisted source snapshot tree digest mismatch.", {
      expected_sha256: value.sha256,
      actual_sha256: treeSha256,
    });
  }
  return deepFreeze(structuredClone(value));
}

export async function writeFrozenRunInputs(options) {
  const { stateDir, runId, manifest, runSpec, sourceSnapshot, workflowPlan, executorInput } = options;
  const paths = frozenRunInputPaths(stateDir, runId);
  const values = {
    manifest: validateSkillManifest(manifest),
    runSpec: validateRunSpec(runSpec),
    sourceSnapshot: validateSourceSnapshot(sourceSnapshot),
    workflowPlan: validateWorkflowPlan(workflowPlan),
    executorInput: validateExecutorInput(executorInput),
  };
  const written = {};
  for (const key of Object.keys(INPUT_FILES)) {
    written[key] = await writeCanonicalPair(paths[key], values[key]);
  }
  return Object.freeze(written);
}

export async function readFrozenRunInputs(stateDir, runId) {
  const paths = frozenRunInputPaths(stateDir, runId);
  const raw = {};
  for (const key of Object.keys(INPUT_FILES)) {
    raw[key] = await readCanonicalPair(paths[key], `Frozen ${key}`);
  }
  return Object.freeze({
    manifest: Object.freeze({
      value: validateSkillManifest(raw.manifest.value, { persisted: true }),
      sha256: raw.manifest.sha256,
    }),
    runSpec: Object.freeze({
      value: validateRunSpec(raw.runSpec.value, { persisted: true }),
      sha256: raw.runSpec.sha256,
    }),
    sourceSnapshot: Object.freeze({
      value: validateSourceSnapshot(raw.sourceSnapshot.value),
      sha256: raw.sourceSnapshot.sha256,
    }),
    workflowPlan: Object.freeze({
      value: validateWorkflowPlan(raw.workflowPlan.value, { persisted: true }),
      sha256: raw.workflowPlan.sha256,
    }),
    executorInput: Object.freeze({
      value: validateExecutorInput(raw.executorInput.value, {
        persisted: true,
      }),
      sha256: raw.executorInput.sha256,
    }),
  });
}

export async function writeRunFailure(artifactRoot, failure) {
  if (failure === null || typeof failure !== "object" || Array.isArray(failure)) {
    throw usageError("Run failure artifact must be an object.");
  }
  return writeCanonicalPair(
    pairPaths(artifactRoot, "failure.jsonl"),
    failure,
  );
}

export async function writeFailedRunEvidence(options) {
  const { artifactRoot, result, verification, failure } = options;
  const written = {};
  if (result !== undefined) {
    written.result = await writeCanonicalPair(
      pairPaths(artifactRoot, "result.jsonl"),
      validateExecutorResult(result, { persisted: true }),
    );
  }
  if (verification !== undefined) {
    written.verification = await writeCanonicalPair(
      pairPaths(artifactRoot, "verification.jsonl"),
      verification,
    );
  }
  written.failure = await writeRunFailure(artifactRoot, failure);
  return Object.freeze(written);
}
