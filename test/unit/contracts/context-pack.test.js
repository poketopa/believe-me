import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_PACK_ENTRY_REQUIRED_FIELDS,
  CONTEXT_PACK_EXCERPT_REQUIRED_FIELDS,
  CONTEXT_PACK_POLICY_REQUIRED_FIELDS,
  CONTEXT_PACK_REQUIRED_FIELDS,
  sha256CanonicalJSON,
  sha256Hex,
  validateContextPack,
} from "../../../src/index.js";

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function pack() {
  const bytes = Buffer.from("export function reserve() {}\n", "utf8");
  const policy = {
    max_files: 2,
    max_excerpts: 4,
    max_total_bytes: 512,
    max_file_bytes: 256,
    max_source_file_bytes: 4096,
  };
  return {
    schema_version: { major: 1 },
    source_snapshot_sha256: digest("snapshot"),
    task_sha256: digest("task"),
    policy_sha256: sha256CanonicalJSON(policy),
    policy,
    selection_status: "matched",
    fallback_reason: null,
    truncated: false,
    truncation_reasons: [],
    omission_counts: {
      binary: 0,
      empty: 0,
      excluded_path: 0,
      oversized: 0,
      secret_content: 0,
    },
    total_files: 1,
    total_excerpts: 1,
    total_bytes: bytes.byteLength,
    entries: [{
      path: "src/reservation.js",
      source_sha256: digest("source"),
      reasons: ["symbol_match", "text_match"],
      excerpts: [{
        start_byte: 0,
        end_byte: bytes.byteLength,
        content_base64: bytes.toString("base64"),
        sha256: sha256Hex(bytes),
        reasons: ["symbol_match", "text_match"],
      }],
    }],
  };
}

test("ContextPack field tables are explicit", () => {
  assert.deepEqual(CONTEXT_PACK_POLICY_REQUIRED_FIELDS, [
    "max_files",
    "max_excerpts",
    "max_total_bytes",
    "max_file_bytes",
    "max_source_file_bytes",
  ]);
  assert.equal(CONTEXT_PACK_REQUIRED_FIELDS.includes("source_snapshot_sha256"), true);
  assert.equal(CONTEXT_PACK_ENTRY_REQUIRED_FIELDS.includes("source_sha256"), true);
  assert.equal(CONTEXT_PACK_EXCERPT_REQUIRED_FIELDS.includes("content_base64"), true);
});

test("ContextPack validates, freezes, and preserves canonical digest", () => {
  const value = validateContextPack(pack());
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.entries[0].excerpts[0]), true);
  assert.equal(
    sha256CanonicalJSON(value),
    sha256CanonicalJSON(JSON.parse(JSON.stringify(value))),
  );
});

test("ContextPack rejects unbound bytes, totals, budgets, and ordering", () => {
  const invalid = [];
  const badDigest = pack();
  badDigest.entries[0].excerpts[0].sha256 = digest("wrong");
  invalid.push(badDigest);
  const badTotal = pack();
  badTotal.total_bytes += 1;
  invalid.push(badTotal);
  const badPolicyDigest = pack();
  badPolicyDigest.policy.max_files = 3;
  invalid.push(badPolicyDigest);
  const badRange = pack();
  badRange.entries[0].excerpts[0].end_byte += 1;
  invalid.push(badRange);
  const badReasons = pack();
  badReasons.entries[0].reasons = ["text_match", "symbol_match"];
  invalid.push(badReasons);

  for (const value of invalid) {
    assert.throws(() => validateContextPack(value), /ContextPack|context|excerpt|policy|entry/u);
  }
});

test("ContextPack requires explicit fallback and truncation state", () => {
  const fallback = pack();
  fallback.selection_status = "fallback";
  fallback.fallback_reason = "no_match";
  fallback.entries[0].reasons = ["no_match_fallback"];
  fallback.entries[0].excerpts[0].reasons = ["no_match_fallback"];
  assert.equal(validateContextPack(fallback).fallback_reason, "no_match");

  const contradictory = pack();
  contradictory.truncated = true;
  assert.throws(() => validateContextPack(contradictory), /truncation/u);
});

test("ContextPack rejects excluded paths, binary bytes, and credential-like excerpts", () => {
  for (const path of [
    "generated/client.js",
    "src/generated/client.js",
    "evidence/previous.jsonl",
    ".omx/state.json",
  ]) {
    const value = pack();
    value.entries[0].path = path;
    assert.throws(() => validateContextPack(value), /excluded/u);
  }

  const binary = pack();
  const binaryBytes = Buffer.from([0, 1]);
  Object.assign(binary.entries[0].excerpts[0], {
    end_byte: binaryBytes.byteLength,
    content_base64: binaryBytes.toString("base64"),
    sha256: sha256Hex(binaryBytes),
  });
  binary.total_bytes = binaryBytes.byteLength;
  assert.throws(() => validateContextPack(binary), /UTF-8/u);

  const secret = pack();
  const secretBytes = Buffer.from('api_key="abcdefghijklmnop"\n', "utf8");
  Object.assign(secret.entries[0].excerpts[0], {
    end_byte: secretBytes.byteLength,
    content_base64: secretBytes.toString("base64"),
    sha256: sha256Hex(secretBytes),
  });
  secret.total_bytes = secretBytes.byteLength;
  assert.throws(() => validateContextPack(secret), /credential/u);
});
