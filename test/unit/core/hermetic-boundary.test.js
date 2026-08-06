import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HERMETIC_REFUSAL_REASON_CODES } from "../../../src/contracts/hermetic-boundary.js";
import { canonicalJSONLine } from "../../../src/core/canonical-json.js";
import {
  hermeticBoundaryPaths,
  readBoundHermeticBoundary,
  readHermeticBoundary,
  writeHermeticBoundary,
} from "../../../src/core/hermetic-boundary.js";
import { sha256Hex } from "../../../src/core/hash.js";
import { runDirectory } from "../../../src/core/run-artifacts.js";

function boundary() {
  return {
    schema_version: { major: 1 },
    mode: "hermetic",
    backend: {
      kind: "bubblewrap",
      runtime_identity: "bwrap-0.11.0",
      image_digest: null,
    },
    platform: { host: "linux", supported_hosts: ["linux"] },
    filesystem: {
      workspace: "read-write",
      root: "read-only",
      host_home: "denied",
      runtime_socket: "denied",
    },
    network: { mode: "none", ambient_egress: "denied" },
    toolchain: { downloads: "denied", mutable_cache: "denied" },
    cleanup: { owner: "backend", residue: "denied" },
    refusal_reason_codes: [...HERMETIC_REFUSAL_REASON_CODES],
  };
}

async function runInputRoot(stateDir, runId) {
  const root = runDirectory(stateDir, runId);
  await mkdir(join(root, "inputs"), { recursive: true, mode: 0o700 });
  return root;
}

async function runRoot(stateDir, runId) {
  const root = runDirectory(stateDir, runId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

test("hermetic boundary publishes one canonical private body and digest", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const runId = "run-hermetic";
  await runRoot(stateDir, runId);

  const written = await writeHermeticBoundary({ stateDir, runId, boundary: boundary() });
  const paths = hermeticBoundaryPaths(stateDir, runId);
  const stored = await readHermeticBoundary(stateDir, runId, { required: true });

  assert.equal(await readFile(paths.body, "utf8"), canonicalJSONLine(written.boundary));
  assert.equal(await readFile(paths.digest, "utf8"), `${written.sha256}\n`);
  assert.equal((await lstat(paths.body)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.digest)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.root)).mode & 0o777, 0o700);
  assert.deepEqual(stored, written);
  await assert.rejects(
    writeHermeticBoundary({ stateDir, runId, boundary: boundary() }),
    /already exists/u,
  );
});

test("concurrent boundary writes admit exactly one authority", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const runId = "run-concurrent";
  await runRoot(stateDir, runId);

  const results = await Promise.allSettled([
    writeHermeticBoundary({ stateDir, runId, boundary: boundary() }),
    writeHermeticBoundary({ stateDir, runId, boundary: boundary() }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await assert.doesNotReject(readHermeticBoundary(stateDir, runId, { required: true }));
});

test("missing authority is legacy-compatible but bound reads fail closed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const runId = "run-legacy";
  await runInputRoot(stateDir, runId);

  assert.equal(await readHermeticBoundary(stateDir, runId), null);
  assert.equal(await readBoundHermeticBoundary(stateDir, runId, undefined), null);
  await assert.rejects(
    readBoundHermeticBoundary(stateDir, runId, "a".repeat(64)),
    /missing authority/u,
  );
});

test("bound reader rejects unbound and mismatched persisted authority", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const runId = "run-bound";
  await runInputRoot(stateDir, runId);
  const written = await writeHermeticBoundary({ stateDir, runId, boundary: boundary() });

  await assert.rejects(
    readBoundHermeticBoundary(stateDir, runId, undefined),
    /no digest binding/u,
  );
  await assert.rejects(
    readBoundHermeticBoundary(stateDir, runId, "b".repeat(64)),
    /does not match/u,
  );
  assert.deepEqual(
    await readBoundHermeticBoundary(stateDir, runId, written.sha256),
    written,
  );
});

test("reader refuses partial tampered noncanonical and symlinked authority", async () => {
  const partialState = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  await runInputRoot(partialState, "partial");
  await writeFile(hermeticBoundaryPaths(partialState, "partial").body, "{}\n");
  await assert.rejects(
    readHermeticBoundary(partialState, "partial"),
    /incomplete/u,
  );

  const tamperedState = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  await runInputRoot(tamperedState, "tampered");
  await writeHermeticBoundary({ stateDir: tamperedState, runId: "tampered", boundary: boundary() });
  const tamperedPaths = hermeticBoundaryPaths(tamperedState, "tampered");
  await writeFile(tamperedPaths.body, `${await readFile(tamperedPaths.body, "utf8")} `);
  await assert.rejects(readHermeticBoundary(tamperedState, "tampered"), /JSON line|digest/u);

  const noncanonicalState = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  await runInputRoot(noncanonicalState, "noncanonical");
  const noncanonicalPaths = hermeticBoundaryPaths(noncanonicalState, "noncanonical");
  const line = `${JSON.stringify(boundary())}\n`;
  await writeFile(noncanonicalPaths.body, line);
  await writeFile(noncanonicalPaths.digest, `${sha256Hex(Buffer.from(line, "utf8"))}\n`);
  await assert.rejects(
    readHermeticBoundary(noncanonicalState, "noncanonical"),
    /canonical JSONL/u,
  );

  const symlinkState = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const symlinkPaths = hermeticBoundaryPaths(symlinkState, "symlink");
  await runInputRoot(symlinkState, "symlink");
  const outside = join(await mkdtemp(join(tmpdir(), "hermetic-outside-")), "body.jsonl");
  await writeFile(outside, canonicalJSONLine(boundary()));
  await symlink(outside, symlinkPaths.body);
  await writeFile(symlinkPaths.digest, `${"0".repeat(64)}\n`);
  await assert.rejects(readHermeticBoundary(symlinkState, "symlink"), /regular files/u);
});

test("reader never creates missing run state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermetic-boundary-"));
  const missingRoot = runDirectory(stateDir, "missing");

  await assert.rejects(readHermeticBoundary(stateDir, "missing"), /ENOENT|real directory/u);
  await assert.rejects(lstat(missingRoot), (error) => error.code === "ENOENT");
});
