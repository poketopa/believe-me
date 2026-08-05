import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  evidencePaths,
  canonicalJSONLine,
  readEvidenceBundle,
  sha256Hex,
  writeEvidenceBundle,
} from "../../../src/index.js";

const hash = "a".repeat(64);

function state(overrides = {}) {
  return {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "verified",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
    artifact_root: "/unused",
    ...overrides,
  };
}

test("evidence bundle writes canonical receipt sidecar and verifies artifacts", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "vah-evidence-"));
  const bundle = await writeEvidenceBundle({
    artifactRoot,
    runState: state({ artifact_root: artifactRoot }),
    verification: { schema_version: { major: 1 }, ok: true },
    result: { schema_version: { major: 1 }, changes: [] },
    issuedAt: "2026-08-05T00:00:00.000Z",
  });

  const paths = evidencePaths(artifactRoot);
  assert.equal(await readFile(paths.receiptDigest, "utf8"), `${bundle.receipt_sha256}\n`);

  const read = await readEvidenceBundle(artifactRoot);
  assert.equal(read.receipt_sha256, bundle.receipt_sha256);
  assert.equal(read.receipt.approval_method, "receipt_sha256");
  assert.deepEqual(read.verification, { schema_version: { major: 1 }, ok: true });
});

test("evidence read refuses tampered receipt bytes", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "vah-evidence-"));
  await writeEvidenceBundle({
    artifactRoot,
    runState: state({ artifact_root: artifactRoot }),
    verification: { schema_version: { major: 1 }, ok: true },
    result: { schema_version: { major: 1 }, changes: [] },
  });

  const paths = evidencePaths(artifactRoot);
  const receipt = await readFile(paths.receipt, "utf8");
  await writeFile(paths.receipt, receipt.replace('"run-1"', '"run-2"'));

  await assert.rejects(
    () => readEvidenceBundle(artifactRoot),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("evidence read refuses hash-matching but non-canonical artifacts", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "vah-evidence-"));
  const bundle = await writeEvidenceBundle({
    artifactRoot,
    runState: state({ artifact_root: artifactRoot }),
    verification: { schema_version: { major: 1 }, ok: true },
    result: { schema_version: { major: 1 }, changes: [] },
  });

  const paths = evidencePaths(artifactRoot);
  const nonCanonical = '{ "ok": true, "schema_version": { "major": 1 } }\n';
  await writeFile(paths.verification, nonCanonical);
  await writeFile(
    paths.receipt,
    canonicalJSONLine({
      ...bundle.receipt,
      verification_sha256: sha256Hex(Buffer.from(nonCanonical, "utf8")),
    }),
  );
  const receiptBytes = await readFile(paths.receipt);
  await writeFile(paths.receiptDigest, `${sha256Hex(receiptBytes)}\n`);

  await assert.rejects(
    () => readEvidenceBundle(artifactRoot),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("evidence read refuses tampered artifact bytes", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "vah-evidence-"));
  await writeEvidenceBundle({
    artifactRoot,
    runState: state({ artifact_root: artifactRoot }),
    verification: { schema_version: { major: 1 }, ok: true },
    result: { schema_version: { major: 1 }, changes: [] },
  });

  const paths = evidencePaths(artifactRoot);
  const tampered = '{"schema_version":{"major":1},"ok":false}\n';
  await writeFile(paths.verification, tampered);
  assert.notEqual(sha256Hex(Buffer.from(tampered, "utf8")), hash);

  await assert.rejects(
    () => readEvidenceBundle(artifactRoot),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});
