import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  advanceStoredRunState,
  readRunState,
  runStateDigestPath,
  runStatePath,
  sha256Hex,
  writeRunState,
} from "../../../src/index.js";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);

function state(overrides = {}) {
  return {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "draft",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
    artifact_root: "/artifacts/run-1",
    ...overrides,
  };
}

test("state store writes canonical JSONL plus digest and validates reads", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  const written = await writeRunState(stateDir, state());

  const line = await readFile(runStatePath(stateDir, "run-1"), "utf8");
  const digestLine = await readFile(runStateDigestPath(stateDir, "run-1"), "utf8");
  assert.equal(line.endsWith("\n"), true);
  assert.equal(digestLine, `${written.sha256}\n`);

  const read = await readRunState(stateDir, "run-1");
  assert.deepEqual(read.state, written.state);
  assert.equal(read.sha256, written.sha256);
});

test("state store refuses tampered persisted state before returning data", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state());
  const line = await readFile(runStatePath(stateDir, "run-1"), "utf8");
  await writeFile(
    runStatePath(stateDir, "run-1"),
    line.replace('"draft"', '"planned"'),
  );

  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("persisted unsupported schema major is a safety refusal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state());
  const unsupported = {
    ...state(),
    schema_version: { major: 2 },
  };
  const line = JSON.stringify(unsupported);
  const crypto = await import("node:crypto");
  await writeFile(runStatePath(stateDir, "run-1"), `${line}\n`);
  await writeFile(
    runStateDigestPath(stateDir, "run-1"),
    `${crypto.createHash("sha256").update(`${line}\n`).digest("hex")}\n`,
  );

  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) =>
      error.code === "persisted_schema_unsupported" && error.exitCode === 3,
  );
});

test("persisted bare integer schema version is a safety refusal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state());
  const unsupported = {
    ...state(),
    schema_version: 1,
  };
  const line = `${JSON.stringify(unsupported)}\n`;
  await writeFile(runStatePath(stateDir, "run-1"), line);
  await writeFile(runStateDigestPath(stateDir, "run-1"), `${sha256Hex(Buffer.from(line, "utf8"))}\n`);

  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) =>
      error.code === "persisted_schema_unsupported" && error.exitCode === 3,
  );
});

test("state store refuses malformed JSON even when digest matches", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state());
  const line = '{"schema_version":\n';
  await writeFile(runStatePath(stateDir, "run-1"), line);
  await writeFile(runStateDigestPath(stateDir, "run-1"), `${sha256Hex(Buffer.from(line, "utf8"))}\n`);

  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("state store validates digest sidecar as exactly one lowercase sha256 line", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state());

  await writeFile(runStateDigestPath(stateDir, "run-1"), `${"A".repeat(64)}\n`);
  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  await writeFile(runStateDigestPath(stateDir, "run-1"), `${hash}\n${hash}\n`);
  await assert.rejects(
    () => readRunState(stateDir, "run-1"),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("advanceStoredRunState revalidates persisted state and lifecycle guards", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(stateDir, state({ lifecycle_state: "verified" }));

  await assert.rejects(
    () => advanceStoredRunState(stateDir, "run-1", { lifecycle_state: "receipted" }),
    /requires observed 'source_snapshot_sha256'/,
  );

  await assert.rejects(
    () =>
      advanceStoredRunState(
        stateDir,
        "run-1",
        { lifecycle_state: "receipted" },
        { observed: { source_snapshot_sha256: otherHash } },
      ),
    /mismatch for 'source_snapshot_sha256'/,
  );

  await assert.rejects(
    () =>
      advanceStoredRunState(
        stateDir,
        "run-1",
        { lifecycle_state: "receipted" },
        { observed: { source_snapshot_sha256: hash } },
      ),
    /without 'receipt_sha256'/,
  );

  const advanced = await advanceStoredRunState(stateDir, "run-1", {
    lifecycle_state: "receipted",
    receipt_sha256: hash,
  }, {
    observed: { source_snapshot_sha256: hash },
  });
  assert.equal(advanced.state.lifecycle_state, "receipted");
});

test("advanceStoredRunState revalidates existing receipt and approval hashes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "vah-state-"));
  await writeRunState(
    stateDir,
    state({
      lifecycle_state: "approved",
      receipt_sha256: hash,
      approval_sha256: hash,
    }),
  );

  await assert.rejects(
    () =>
      advanceStoredRunState(
        stateDir,
        "run-1",
        { lifecycle_state: "applied" },
        { observed: { source_snapshot_sha256: hash } },
      ),
    /requires observed 'receipt_sha256'/,
  );

  await assert.rejects(
    () =>
      advanceStoredRunState(
        stateDir,
        "run-1",
        { lifecycle_state: "applied" },
        { observed: { source_snapshot_sha256: hash, receipt_sha256: otherHash } },
      ),
    /mismatch for 'receipt_sha256'/,
  );

  await assert.rejects(
    () =>
      advanceStoredRunState(
        stateDir,
        "run-1",
        { lifecycle_state: "applied" },
        {
          observed: {
            source_snapshot_sha256: hash,
            receipt_sha256: hash,
            approval_sha256: otherHash,
          },
        },
      ),
    /mismatch for 'approval_sha256'/,
  );

  const advanced = await advanceStoredRunState(
    stateDir,
    "run-1",
    { lifecycle_state: "applied" },
    {
      observed: {
        source_snapshot_sha256: hash,
        receipt_sha256: hash,
        approval_sha256: hash,
      },
    },
  );
  assert.equal(advanced.state.lifecycle_state, "applied");
});
