import {
  assertEnum,
  assertObject,
  assertRequiredFields,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";
import { sha256CanonicalJSON, sha256Hex } from "../core/hash.js";

export const CONTEXT_PACK_SELECTION_STATUSES = Object.freeze([
  "matched",
  "fallback",
  "empty",
]);

export const CONTEXT_PACK_FALLBACK_REASONS = Object.freeze([
  "no_match",
  "no_admitted_text",
  "budget_exhausted",
]);

export const CONTEXT_PACK_SELECTION_REASONS = Object.freeze([
  "path_match",
  "name_match",
  "text_match",
  "symbol_match",
  "no_match_fallback",
]);

export const CONTEXT_PACK_OMISSION_REASONS = Object.freeze([
  "binary",
  "empty",
  "excluded_path",
  "oversized",
  "secret_content",
]);

export const CONTEXT_PACK_POLICY_REQUIRED_FIELDS = Object.freeze([
  "max_files",
  "max_excerpts",
  "max_total_bytes",
  "max_file_bytes",
  "max_source_file_bytes",
]);

export const CONTEXT_PACK_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "source_snapshot_sha256",
  "task_sha256",
  "policy_sha256",
  "policy",
  "selection_status",
  "fallback_reason",
  "truncated",
  "truncation_reasons",
  "omission_counts",
  "total_files",
  "total_excerpts",
  "total_bytes",
  "entries",
]);

export const CONTEXT_PACK_ENTRY_REQUIRED_FIELDS = Object.freeze([
  "path",
  "source_sha256",
  "reasons",
  "excerpts",
]);

export const CONTEXT_PACK_EXCERPT_REQUIRED_FIELDS = Object.freeze([
  "start_byte",
  "end_byte",
  "content_base64",
  "sha256",
  "reasons",
]);

const NORMALIZED_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\\0]+$/u;

function assertPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`${field} must be a positive safe integer.`, { field });
  }
}

function assertNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError(`${field} must be a non-negative safe integer.`, { field });
  }
}

function assertSortedUniqueStrings(value, field, allowedValues) {
  if (!Array.isArray(value)) {
    throw usageError(`${field} must be an array.`, { field });
  }
  let previous = null;
  for (const item of value) {
    assertEnum(item, field, allowedValues);
    if (previous !== null && item <= previous) {
      throw usageError(`${field} must be unique and code-unit sorted.`, { field });
    }
    previous = item;
  }
}

export function validateContextPackPolicy(value) {
  assertRequiredFields(
    value,
    CONTEXT_PACK_POLICY_REQUIRED_FIELDS,
    "ContextPack policy",
  );
  for (const field of CONTEXT_PACK_POLICY_REQUIRED_FIELDS) {
    assertPositiveSafeInteger(value[field], `policy.${field}`);
  }
  if (value.max_file_bytes > value.max_total_bytes) {
    throw usageError("policy.max_file_bytes must not exceed max_total_bytes.");
  }
  return deepFreeze(structuredClone(value));
}

function validateExcerpt(value, entryPath) {
  assertRequiredFields(value, CONTEXT_PACK_EXCERPT_REQUIRED_FIELDS, "ContextPack excerpt");
  assertNonNegativeSafeInteger(value.start_byte, "excerpt.start_byte");
  assertNonNegativeSafeInteger(value.end_byte, "excerpt.end_byte");
  if (value.end_byte <= value.start_byte) {
    throw usageError("ContextPack excerpt byte range must be non-empty.", {
      path: entryPath,
    });
  }
  assertString(value.content_base64, "excerpt.content_base64");
  const bytes = Buffer.from(value.content_base64, "base64");
  if (
    bytes.toString("base64") !== value.content_base64 ||
    bytes.byteLength !== value.end_byte - value.start_byte
  ) {
    throw usageError("ContextPack excerpt bytes do not match their declared range.", {
      path: entryPath,
    });
  }
  assertSha256Hex(value.sha256, "excerpt.sha256");
  if (sha256Hex(bytes) !== value.sha256) {
    throw usageError("ContextPack excerpt digest mismatch.", { path: entryPath });
  }
  assertSortedUniqueStrings(
    value.reasons,
    "excerpt.reasons",
    CONTEXT_PACK_SELECTION_REASONS,
  );
  if (value.reasons.length === 0) {
    throw usageError("ContextPack excerpt must record at least one selection reason.");
  }
  return bytes.byteLength;
}

function validateEntries(entries, policy) {
  if (!Array.isArray(entries)) {
    throw usageError("ContextPack entries must be an array.");
  }
  if (entries.length > policy.max_files) {
    throw usageError("ContextPack exceeds its maximum file budget.");
  }

  let previousPath = null;
  let totalExcerpts = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    assertRequiredFields(entry, CONTEXT_PACK_ENTRY_REQUIRED_FIELDS, "ContextPack entry");
    assertString(entry.path, "entry.path");
    if (!NORMALIZED_PATH_PATTERN.test(entry.path) || entry.path.endsWith("/")) {
      throw usageError("ContextPack entry path must be normalized and relative.", {
        path: entry.path,
      });
    }
    if (previousPath !== null && entry.path <= previousPath) {
      throw usageError("ContextPack entry paths must be unique and code-unit sorted.");
    }
    previousPath = entry.path;
    assertSha256Hex(entry.source_sha256, "entry.source_sha256");
    assertSortedUniqueStrings(
      entry.reasons,
      "entry.reasons",
      CONTEXT_PACK_SELECTION_REASONS,
    );
    if (entry.reasons.length === 0 || !Array.isArray(entry.excerpts) || entry.excerpts.length === 0) {
      throw usageError("ContextPack entries require reasons and excerpts.", {
        path: entry.path,
      });
    }

    let fileBytes = 0;
    let previousEnd = -1;
    for (const excerpt of entry.excerpts) {
      if (excerpt.start_byte < previousEnd) {
        throw usageError("ContextPack excerpt byte ranges must be ordered and non-overlapping.", {
          path: entry.path,
        });
      }
      fileBytes += validateExcerpt(excerpt, entry.path);
      previousEnd = excerpt.end_byte;
    }
    if (fileBytes > policy.max_file_bytes) {
      throw usageError("ContextPack entry exceeds its per-file byte budget.", {
        path: entry.path,
      });
    }
    totalExcerpts += entry.excerpts.length;
    totalBytes += fileBytes;
  }
  if (totalExcerpts > policy.max_excerpts || totalBytes > policy.max_total_bytes) {
    throw usageError("ContextPack exceeds its excerpt or total byte budget.");
  }
  return { totalExcerpts, totalBytes };
}

export function validateContextPack(value, options = {}) {
  validateContractBase(value, CONTEXT_PACK_REQUIRED_FIELDS, "ContextPack", options);
  assertSha256Hex(value.source_snapshot_sha256, "source_snapshot_sha256");
  assertSha256Hex(value.task_sha256, "task_sha256");
  assertSha256Hex(value.policy_sha256, "policy_sha256");
  const policy = validateContextPackPolicy(value.policy);
  if (sha256CanonicalJSON(policy) !== value.policy_sha256) {
    throw usageError("ContextPack policy digest mismatch.");
  }
  assertEnum(
    value.selection_status,
    "selection_status",
    CONTEXT_PACK_SELECTION_STATUSES,
  );
  if (value.fallback_reason !== null) {
    assertEnum(
      value.fallback_reason,
      "fallback_reason",
      CONTEXT_PACK_FALLBACK_REASONS,
    );
  }
  if (typeof value.truncated !== "boolean") {
    throw usageError("ContextPack truncated must be boolean.");
  }
  assertSortedUniqueStrings(
    value.truncation_reasons,
    "truncation_reasons",
    CONTEXT_PACK_FALLBACK_REASONS,
  );
  assertObject(value.omission_counts, "omission_counts");
  for (const reason of CONTEXT_PACK_OMISSION_REASONS) {
    assertNonNegativeSafeInteger(
      value.omission_counts[reason],
      `omission_counts.${reason}`,
    );
  }
  assertNonNegativeSafeInteger(value.total_files, "total_files");
  assertNonNegativeSafeInteger(value.total_excerpts, "total_excerpts");
  assertNonNegativeSafeInteger(value.total_bytes, "total_bytes");
  const computed = validateEntries(value.entries, policy);
  if (
    value.total_files !== value.entries.length ||
    value.total_excerpts !== computed.totalExcerpts ||
    value.total_bytes !== computed.totalBytes
  ) {
    throw usageError("ContextPack totals do not match its entries.");
  }
  if (value.selection_status === "matched" && value.fallback_reason !== null) {
    throw usageError("Matched ContextPack must not record a fallback reason.");
  }
  if (value.selection_status !== "matched" && value.fallback_reason === null) {
    throw usageError("Fallback or empty ContextPack must record a fallback reason.");
  }
  if (value.selection_status === "empty" && value.entries.length !== 0) {
    throw usageError("Empty ContextPack must not contain entries.");
  }
  if (value.selection_status !== "empty" && value.entries.length === 0) {
    throw usageError("Non-empty ContextPack status requires at least one entry.");
  }
  if (value.truncated !== (value.truncation_reasons.length > 0)) {
    throw usageError("ContextPack truncation flag and reasons are inconsistent.");
  }
  return deepFreeze(structuredClone(value));
}

export const freezeContextPack = validateContextPack;
