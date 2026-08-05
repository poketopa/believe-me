import { basename, extname, resolve } from "node:path";
import { validateContextPack, validateContextPackPolicy } from "../contracts/context-pack.js";
import { safetyRefusal, usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "./canonical-json.js";
import { sha256CanonicalJSON, sha256Hex } from "./hash.js";
import { containsLikelyCredential } from "./secrets.js";
import {
  assertInsideRoot,
  compareCodeUnit,
  isExcludedRelativePath,
  normalizeRelativePath,
  readRegularFileNoFollow,
} from "./snapshot.js";

const LOCALIZATION_EXCLUDED_DIRECTORIES = new Set([
  ".omx",
  "coverage",
  "artifacts",
]);
const TOKEN_PATTERN = /[\p{L}\p{N}_$.-]+/gu;
const SYMBOL_PATTERN = /[$_\p{L}][$_\p{L}\p{N}]*/gu;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_CONTEXT_PACK_POLICY = Object.freeze({
  max_files: 12,
  max_excerpts: 24,
  max_total_bytes: 32_768,
  max_file_bytes: 4_096,
  max_source_file_bytes: 1_048_576,
});

function emptyOmissionCounts() {
  return {
    binary: 0,
    empty: 0,
    excluded_path: 0,
    oversized: 0,
    secret_content: 0,
  };
}

function localizationExcluded(path) {
  return isExcludedRelativePath(path) || path
    .split("/")
    .some((part) => LOCALIZATION_EXCLUDED_DIRECTORIES.has(part));
}

function tokenizeTask(task) {
  if (typeof task !== "string" || task.trim() === "" || task.includes("\0")) {
    throw usageError("ContextPack task must be a non-empty bounded string.");
  }
  const bytes = Buffer.from(task, "utf8");
  if (bytes.byteLength > 50_000) {
    throw usageError("ContextPack task exceeds the admitted byte boundary.");
  }
  return [...new Set((task.match(TOKEN_PATTERN) ?? [])
    .map((token) => token.toLocaleLowerCase("en-US"))
    .filter((token) => token.length >= 2))]
    .sort(compareCodeUnit)
    .slice(0, 256);
}

function decodeText(bytes) {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function safeUtf8Prefix(bytes, maximum) {
  let end = Math.min(bytes.byteLength, maximum);
  while (end > 0) {
    const candidate = bytes.subarray(0, end);
    try {
      UTF8_DECODER.decode(candidate);
      return candidate;
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function fileReasons(path, text, tokens) {
  const lowerPath = path.toLocaleLowerCase("en-US");
  const fileName = basename(path, extname(path)).toLocaleLowerCase("en-US");
  const pathTokens = new Set(
    (lowerPath.match(SYMBOL_PATTERN) ?? [])
      .map((token) => token.toLocaleLowerCase("en-US")),
  );
  const normalizedSymbols = (text.match(SYMBOL_PATTERN) ?? [])
    .map((symbol) => symbol.toLocaleLowerCase("en-US"));
  const symbols = new Set(normalizedSymbols);
  const textTokens = new Set(normalizedSymbols);
  const reasons = new Set();
  let score = 0;
  for (const token of tokens) {
    if (pathTokens.has(token)) {
      reasons.add("path_match");
      score += 8;
    }
    if (fileName === token) {
      reasons.add("name_match");
      score += 12;
    }
    if (symbols.has(token)) {
      reasons.add("symbol_match");
      score += 6;
    }
    if (textTokens.has(token)) {
      reasons.add("text_match");
      score += 2;
    }
  }
  return { reasons: [...reasons].sort(compareCodeUnit), score };
}

function lineRanges(bytes, text) {
  const lines = text.split(/(?<=\n)/u);
  const ranges = [];
  let offset = 0;
  for (const line of lines) {
    const length = Buffer.byteLength(line, "utf8");
    ranges.push({ start: offset, end: offset + length, text: line });
    offset += length;
  }
  if (ranges.length === 0 && bytes.byteLength > 0) {
    ranges.push({ start: 0, end: bytes.byteLength, text });
  }
  return ranges;
}

function matchedExcerptRanges(bytes, text, tokens, fallback) {
  const lines = lineRanges(bytes, text);
  if (fallback) {
    return lines.length === 0 ? [] : [{
      start: 0,
      end: Math.min(bytes.byteLength, lines.slice(0, 3).at(-1)?.end ?? bytes.byteLength),
    }];
  }
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].text.toLocaleLowerCase("en-US");
    if (tokens.some((token) => lower.includes(token))) {
      indexes.push(index);
    }
  }
  const ranges = indexes.map((index) => ({
    start: lines[Math.max(0, index - 1)].start,
    end: lines[Math.min(lines.length - 1, index + 1)].end,
  }));
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function buildExcerpts(candidate, tokens, fallback, remaining, maximumExcerpts) {
  const reasons = fallback
    ? ["no_match_fallback"]
    : candidate.reasons;
  const excerpts = [];
  let fileBytes = 0;
  let truncated = false;
  for (const range of matchedExcerptRanges(
    candidate.bytes,
    candidate.text,
    tokens,
    fallback,
  )) {
    if (excerpts.length >= maximumExcerpts) {
      truncated = true;
      break;
    }
    if (remaining.excerpts <= 0 || remaining.totalBytes <= 0) {
      truncated = true;
      break;
    }
    const available = Math.min(
      remaining.totalBytes,
      remaining.fileBytes - fileBytes,
    );
    if (available <= 0) {
      truncated = true;
      break;
    }
    const raw = candidate.bytes.subarray(range.start, range.end);
    const selected = safeUtf8Prefix(raw, available);
    if (selected.byteLength === 0) {
      truncated = true;
      break;
    }
    if (selected.byteLength < raw.byteLength) {
      truncated = true;
    }
    excerpts.push({
      start_byte: range.start,
      end_byte: range.start + selected.byteLength,
      content_base64: selected.toString("base64"),
      sha256: sha256Hex(selected),
      reasons,
    });
    fileBytes += selected.byteLength;
    remaining.excerpts -= 1;
    remaining.totalBytes -= selected.byteLength;
  }
  return { excerpts, fileBytes, truncated };
}

function assertSnapshot(snapshot) {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.entries) ||
    !/^[a-f0-9]{64}$/u.test(snapshot.sha256 ?? "")
  ) {
    throw usageError("ContextPack requires a frozen source snapshot.");
  }
  if (snapshot.schema_version?.major !== 1) {
    throw usageError("ContextPack source snapshot schema is unsupported.");
  }
  let previousPath = null;
  for (const entry of snapshot.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") ||
      (previousPath !== null && entry.path <= previousPath)
    ) {
      throw usageError("ContextPack source snapshot entries must be valid, unique, and sorted.");
    }
    previousPath = entry.path;
  }
  const treeSha256 = sha256CanonicalJSON({
    schema_version: snapshot.schema_version,
    entries: snapshot.entries,
  });
  if (treeSha256 !== snapshot.sha256) {
    throw safetyRefusal("ContextPack source snapshot digest mismatch.", {
      expected_sha256: snapshot.sha256,
      actual_sha256: treeSha256,
    });
  }
}

export async function buildContextPack(options) {
  if (typeof options?.projectRoot !== "string" || options.projectRoot.length === 0) {
    throw usageError("ContextPack projectRoot must be a non-empty path.");
  }
  const projectRoot = resolve(options.projectRoot);
  const snapshot = options?.sourceSnapshot;
  const task = options?.task;
  assertSnapshot(snapshot);
  const policy = validateContextPackPolicy(
    options?.policy ?? DEFAULT_CONTEXT_PACK_POLICY,
  );
  const tokens = tokenizeTask(task);
  const omissions = emptyOmissionCounts();
  const candidates = [];

  for (const snapshotEntry of [...snapshot.entries]
    .sort((left, right) => compareCodeUnit(left.path, right.path))) {
    const path = normalizeRelativePath(projectRoot, snapshotEntry.path);
    if (localizationExcluded(path)) {
      omissions.excluded_path += 1;
      continue;
    }
    if (snapshotEntry.size > policy.max_source_file_bytes) {
      omissions.oversized += 1;
      continue;
    }
    const absolute = assertInsideRoot(projectRoot, path);
    const { bytes } = await readRegularFileNoFollow(absolute, path);
    if (
      bytes.byteLength !== snapshotEntry.size ||
      sha256Hex(bytes) !== snapshotEntry.sha256
    ) {
      throw safetyRefusal("ContextPack source bytes differ from the frozen snapshot.", {
        path,
      });
    }
    if (bytes.byteLength === 0) {
      omissions.empty += 1;
      continue;
    }
    const text = decodeText(bytes);
    if (text === null) {
      omissions.binary += 1;
      continue;
    }
    if (containsLikelyCredential(bytes)) {
      omissions.secret_content += 1;
      continue;
    }
    const match = fileReasons(path, text, tokens);
    candidates.push({
      path,
      sourceSha256: snapshotEntry.sha256,
      bytes,
      text,
      ...match,
    });
  }

  const matches = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || compareCodeUnit(left.path, right.path));
  const fallback = matches.length === 0;
  const ordered = fallback
    ? [...candidates].sort((left, right) => compareCodeUnit(left.path, right.path))
    : matches;
  const selected = [];
  const remaining = {
    excerpts: policy.max_excerpts,
    totalBytes: policy.max_total_bytes,
    fileBytes: policy.max_file_bytes,
  };
  let budgetTruncated = ordered.length > policy.max_files;
  const candidateLimit = Math.min(ordered.length, policy.max_files);
  const excerptsPerCandidate = Math.max(
    1,
    Math.floor(policy.max_excerpts / Math.max(1, candidateLimit)),
  );
  for (const candidate of ordered.slice(0, policy.max_files)) {
    const built = buildExcerpts(
      candidate,
      tokens,
      fallback,
      remaining,
      excerptsPerCandidate,
    );
    budgetTruncated ||= built.truncated;
    if (built.excerpts.length === 0) {
      continue;
    }
    selected.push({
      path: candidate.path,
      source_sha256: candidate.sourceSha256,
      reasons: fallback ? ["no_match_fallback"] : candidate.reasons,
      excerpts: built.excerpts,
    });
  }
  selected.sort((left, right) => compareCodeUnit(left.path, right.path));

  let selectionStatus = fallback ? "fallback" : "matched";
  let fallbackReason = fallback ? "no_match" : null;
  if (selected.length === 0) {
    selectionStatus = "empty";
    fallbackReason = candidates.length === 0
      ? "no_admitted_text"
      : "budget_exhausted";
  }
  const truncationReasons = budgetTruncated || selected.length < Math.min(ordered.length, policy.max_files)
    ? ["budget_exhausted"]
    : [];
  const totalExcerpts = selected.reduce((sum, entry) => sum + entry.excerpts.length, 0);
  const totalBytes = selected.reduce(
    (sum, entry) => sum + entry.excerpts.reduce(
      (entrySum, excerpt) => entrySum + excerpt.end_byte - excerpt.start_byte,
      0,
    ),
    0,
  );
  return validateContextPack({
    schema_version: { major: 1 },
    source_snapshot_sha256: snapshot.sha256,
    task_sha256: sha256Hex(Buffer.from(task, "utf8")),
    policy_sha256: sha256Hex(canonicalJSONBytes(policy)),
    policy,
    selection_status: selectionStatus,
    fallback_reason: fallbackReason,
    truncated: truncationReasons.length > 0,
    truncation_reasons: truncationReasons,
    omission_counts: omissions,
    total_files: selected.length,
    total_excerpts: totalExcerpts,
    total_bytes: totalBytes,
    entries: selected,
  });
}
