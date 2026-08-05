import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJSONLine, canonicalJSONLineBytes } from "../core/canonical-json.js";
import { sha256Hex } from "../core/hash.js";
import { compareCodeUnit, readRegularFileNoFollow } from "../core/snapshot.js";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import {
  validateBenchmarkExperiment,
  validateBenchmarkPairResult,
  validateComparisonV2Experiment,
  validateComparisonV2PairResult,
} from "./contracts.js";
import {
  summarizeBenchmarkPairs,
  summarizeComparisonV2Pairs,
} from "./statistics.js";

const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/u;

function record(recordType, value) {
  return Object.freeze({
    record_type: recordType,
    record_sha256: sha256Hex(canonicalJSONLineBytes(value)),
    value,
  });
}

function comparePairs(left, right) {
  return compareCodeUnit(left.task.pair_id, right.task.pair_id);
}

function assertExperimentBinding(experiment, pair) {
  if (
    sha256Hex(canonicalJSONLineBytes(experiment)) !==
    sha256Hex(canonicalJSONLineBytes(pair.experiment))
  ) {
    throw usageError("Benchmark ledger pair experiment binding does not match.", {
      pair_id: pair.task.pair_id,
    });
  }
}

export function buildBenchmarkLedger({
  experiment,
  pairs,
  summaryOptions,
} = {}) {
  const validatedExperiment = validateBenchmarkExperiment(experiment);
  if (!Array.isArray(pairs)) {
    throw usageError("Benchmark ledger pairs must be an array.");
  }
  const validatedPairs = pairs
    .map((pair) => validateBenchmarkPairResult(pair))
    .toSorted(comparePairs);
  for (const pair of validatedPairs) {
    assertExperimentBinding(validatedExperiment, pair);
  }
  const summary = summarizeBenchmarkPairs(validatedPairs, summaryOptions);
  const records = [record("experiment", validatedExperiment)];
  for (const pair of validatedPairs) {
    records.push(
      record("task", pair.task),
      record("arm_result", pair.direct_codex),
      record("arm_result", pair.harness),
      record("pair_result", pair),
    );
  }
  records.push(record("summary", summary));
  const bytes = Buffer.from(records.map(canonicalJSONLine).join(""), "utf8");
  return Object.freeze({
    records: Object.freeze(records),
    bytes,
    sha256: sha256Hex(bytes),
    experiment: validatedExperiment,
    pairs: Object.freeze(validatedPairs),
    summary,
  });
}

function parseCanonicalRecords(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || !text.endsWith("\n")) {
    throw safetyRefusal("Benchmark ledger must be canonical UTF-8 JSONL.");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw safetyRefusal("Benchmark ledger contains an empty JSONL record.");
  }
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw safetyRefusal("Benchmark ledger contains malformed JSON.", {
        line: index + 1,
      });
    }
    if (canonicalJSONLine(parsed) !== `${line}\n`) {
      throw safetyRefusal("Benchmark ledger record is not canonical JSON.", {
        line: index + 1,
      });
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof parsed.record_type !== "string" ||
      typeof parsed.record_sha256 !== "string" ||
      !Object.hasOwn(parsed, "value")
    ) {
      throw safetyRefusal("Benchmark ledger record wrapper is invalid.", {
        line: index + 1,
      });
    }
    const actual = sha256Hex(canonicalJSONLineBytes(parsed.value));
    if (actual !== parsed.record_sha256) {
      throw safetyRefusal("Benchmark ledger record digest mismatch.", {
        line: index + 1,
      });
    }
    return parsed;
  });
}

export function parseBenchmarkLedger(raw) {
  const records = parseCanonicalRecords(raw);
  if (records[0]?.record_type !== "experiment" ||
      records.at(-1)?.record_type !== "summary") {
    throw safetyRefusal("Benchmark ledger record order is invalid.");
  }
  const experiment = validateBenchmarkExperiment(records[0].value, {
    persisted: true,
  });
  const pairRecords = records
    .filter((entry) => entry.record_type === "pair_result")
    .map((entry) => validateBenchmarkPairResult(entry.value, {
      persisted: true,
    }));
  const summary = records.at(-1).value;
  const rebuilt = buildBenchmarkLedger({
    experiment,
    pairs: pairRecords,
    summaryOptions: {
      seed: summary?.bootstrap?.seed,
      bootstrap_replicates: summary?.bootstrap?.replicates,
    },
  });
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!rebuilt.bytes.equals(bytes)) {
    throw safetyRefusal(
      "Benchmark ledger rows or summary do not match their canonical replay.",
    );
  }
  return Object.freeze({
    records: rebuilt.records,
    experiment: rebuilt.experiment,
    pairs: rebuilt.pairs,
    summary: rebuilt.summary,
    sha256: rebuilt.sha256,
  });
}

async function writeExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
    await rm(temporary, { force: true });
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeBenchmarkLedger({ path, ...options } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw usageError("Benchmark ledger path must be a non-empty string.");
  }
  const built = buildBenchmarkLedger(options);
  await writeExclusive(path, built.bytes);
  await writeExclusive(`${path}.sha256`, Buffer.from(`${built.sha256}\n`, "utf8"));
  return Object.freeze({
    path,
    digest_path: `${path}.sha256`,
    sha256: built.sha256,
    summary: built.summary,
  });
}

export async function readBenchmarkLedger(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw usageError("Benchmark ledger path must be a non-empty string.");
  }
  const [ledger, digest] = await Promise.all([
    readRegularFileNoFollow(path, "Benchmark ledger"),
    readRegularFileNoFollow(`${path}.sha256`, "Benchmark ledger digest"),
  ]);
  const digestLine = digest.bytes.toString("utf8");
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(
      "Benchmark ledger digest must be one lowercase SHA-256 line.",
    );
  }
  const actual = sha256Hex(ledger.bytes);
  if (actual !== digestLine.slice(0, -1)) {
    throw safetyRefusal("Benchmark ledger digest mismatch.");
  }
  const parsed = parseBenchmarkLedger(ledger.bytes);
  if (parsed.sha256 !== actual) {
    throw safetyRefusal("Benchmark ledger replay digest mismatch.");
  }
  return Object.freeze({
    ...parsed,
    path,
    digest_path: `${path}.sha256`,
  });
}

function assertComparisonV2ExperimentBinding(experiment, pair) {
  if (
    sha256Hex(canonicalJSONLineBytes(experiment)) !==
    sha256Hex(canonicalJSONLineBytes(pair.experiment))
  ) {
    throw usageError("Comparison-v2 ledger pair experiment binding does not match.", {
      pair_id: pair.task.pair_id,
    });
  }
}

export function buildComparisonV2Ledger({
  experiment,
  pairs,
  summaryOptions,
} = {}) {
  const validatedExperiment = validateComparisonV2Experiment(experiment);
  if (!Array.isArray(pairs)) {
    throw usageError("Comparison-v2 ledger pairs must be an array.");
  }
  const validatedPairs = pairs
    .map((pair) => validateComparisonV2PairResult(pair))
    .toSorted(comparePairs);
  for (const pair of validatedPairs) {
    assertComparisonV2ExperimentBinding(validatedExperiment, pair);
  }
  const summary = summarizeComparisonV2Pairs(validatedPairs, summaryOptions);
  const records = [record("comparison_v2_experiment", validatedExperiment)];
  for (const pair of validatedPairs) {
    records.push(
      record("comparison_v2_task", pair.task),
      record("comparison_v2_arm_result", pair.control),
      record("comparison_v2_arm_result", pair.treatment),
      record("comparison_v2_pair_result", pair),
    );
  }
  records.push(record("comparison_v2_summary", summary));
  const bytes = Buffer.from(records.map(canonicalJSONLine).join(""), "utf8");
  return Object.freeze({
    records: Object.freeze(records),
    bytes,
    sha256: sha256Hex(bytes),
    experiment: validatedExperiment,
    pairs: Object.freeze(validatedPairs),
    summary,
  });
}

export function parseComparisonV2Ledger(raw) {
  const records = parseCanonicalRecords(raw);
  if (
    records[0]?.record_type !== "comparison_v2_experiment" ||
    records.at(-1)?.record_type !== "comparison_v2_summary"
  ) {
    throw safetyRefusal("Comparison-v2 ledger record order is invalid.");
  }
  const experiment = validateComparisonV2Experiment(records[0].value, {
    persisted: true,
  });
  const pairRecords = records
    .filter((entry) => entry.record_type === "comparison_v2_pair_result")
    .map((entry) => validateComparisonV2PairResult(entry.value, {
      persisted: true,
    }));
  const summary = records.at(-1).value;
  const rebuilt = buildComparisonV2Ledger({
    experiment,
    pairs: pairRecords,
    summaryOptions: {
      seed: summary?.bootstrap?.seed,
      bootstrap_replicates: summary?.bootstrap?.replicates,
    },
  });
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!rebuilt.bytes.equals(bytes)) {
    throw safetyRefusal(
      "Comparison-v2 ledger rows or summary do not match their canonical replay.",
    );
  }
  return Object.freeze({
    records: rebuilt.records,
    experiment: rebuilt.experiment,
    pairs: rebuilt.pairs,
    summary: rebuilt.summary,
    sha256: rebuilt.sha256,
  });
}

export async function writeComparisonV2Ledger({ path, ...options } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw usageError("Comparison-v2 ledger path must be a non-empty string.");
  }
  const built = buildComparisonV2Ledger(options);
  await writeExclusive(path, built.bytes);
  await writeExclusive(`${path}.sha256`, Buffer.from(`${built.sha256}\n`, "utf8"));
  return Object.freeze({
    path,
    digest_path: `${path}.sha256`,
    sha256: built.sha256,
    summary: built.summary,
  });
}

export async function readComparisonV2Ledger(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw usageError("Comparison-v2 ledger path must be a non-empty string.");
  }
  const [ledger, digest] = await Promise.all([
    readRegularFileNoFollow(path, "Comparison-v2 ledger"),
    readRegularFileNoFollow(`${path}.sha256`, "Comparison-v2 ledger digest"),
  ]);
  const digestLine = digest.bytes.toString("utf8");
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(
      "Comparison-v2 ledger digest must be one lowercase SHA-256 line.",
    );
  }
  const actual = sha256Hex(ledger.bytes);
  if (actual !== digestLine.slice(0, -1)) {
    throw safetyRefusal("Comparison-v2 ledger digest mismatch.");
  }
  const parsed = parseComparisonV2Ledger(ledger.bytes);
  if (parsed.sha256 !== actual) {
    throw safetyRefusal("Comparison-v2 ledger replay digest mismatch.");
  }
  return Object.freeze({
    ...parsed,
    path,
    digest_path: `${path}.sha256`,
  });
}
