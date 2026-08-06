import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJSONLine, canonicalJSONLineBytes } from "../../../src/core/canonical-json.js";
import { sha256Hex } from "../../../src/core/hash.js";
import {
  PORTABLE_EVIDENCE_MAX_BYTES,
  PORTABLE_EVIDENCE_FIELDS,
  PORTABLE_EXPORT_CONTEXT_FIELDS,
  buildPortableEvidenceBundle,
  readPortableEvidenceBundle,
  verifyPortableEvidenceBytes,
  writePortableEvidenceBundle,
} from "../../../src/core/portable-evidence.js";

const stateSha256 = "a".repeat(64);

test("portable contract field tables are explicit", () => {
  assert.deepEqual(PORTABLE_EVIDENCE_FIELDS, [
    "schema_version",
    "bundle_kind",
    "export_context",
    "receipt_sha256",
    "receipt",
    "verification",
    "result",
  ]);
  assert.deepEqual(PORTABLE_EXPORT_CONTEXT_FIELDS, [
    "run_id",
    "lifecycle_state",
    "state_sha256",
    "executor_kind",
  ]);
});

function fixture(overrides = {}) {
  const content = Buffer.from("portable candidate\n", "utf8");
  const verification = {
    schema_version: { major: 1 },
    adapter_id: "manifest-command",
    status: "passed",
  };
  const result = {
    schema_version: { major: 1 },
    run_id: "run-portable",
    executor_kind: "deterministic",
    status: "completed",
    changes: [{
      path: "src/portable.txt",
      content_base64: content.toString("base64"),
      sha256: sha256Hex(content),
    }],
  };
  const receipt = {
    schema_version: { major: 1 },
    run_id: "run-portable",
    manifest_sha256: "b".repeat(64),
    workflow_plan_sha256: "c".repeat(64),
    source_snapshot_sha256: "d".repeat(64),
    verification_sha256: sha256Hex(canonicalJSONLineBytes(verification)),
    result_sha256: sha256Hex(canonicalJSONLineBytes(result)),
    approval_method: "receipt_sha256",
    issued_at: "2026-08-05T23:00:00.000Z",
  };
  const receiptSha256 = sha256Hex(canonicalJSONLineBytes(receipt));
  const state = {
    run_id: "run-portable",
    lifecycle_state: "receipted",
    manifest_sha256: receipt.manifest_sha256,
    workflow_plan_sha256: receipt.workflow_plan_sha256,
    source_snapshot_sha256: receipt.source_snapshot_sha256,
    executor_kind: "deterministic",
    receipt_sha256: receiptSha256,
  };
  return {
    state: { ...state, ...overrides.state },
    stateSha256: overrides.stateSha256 ?? stateSha256,
    evidence: {
      receipt_sha256: receiptSha256,
      receipt,
      verification,
      result,
      ...overrides.evidence,
    },
  };
}

function rebuiltValue(value, changes) {
  return canonicalJSONLineBytes({ ...value, ...changes });
}

function withoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function rebuildEmbedded(bundle, changes = {}) {
  const verification = changes.verification ?? bundle.value.verification;
  const result = changes.result ?? bundle.value.result;
  const receipt = {
    ...bundle.value.receipt,
    verification_sha256: sha256Hex(canonicalJSONLineBytes(verification)),
    result_sha256: sha256Hex(canonicalJSONLineBytes(result)),
    ...changes.receipt,
  };
  return canonicalJSONLineBytes({
    ...bundle.value,
    receipt,
    receipt_sha256: sha256Hex(canonicalJSONLineBytes(receipt)),
    verification,
    result,
    ...changes.envelope,
  });
}

function replaceReplacementCharactersWithInvalidUtf8(bytes) {
  const output = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (
      bytes[index] === 0xef &&
      bytes[index + 1] === 0xbf &&
      bytes[index + 2] === 0xbd
    ) {
      output.push(0xff);
      index += 2;
    } else {
      output.push(bytes[index]);
    }
  }
  return Buffer.from(output);
}

test("portable bundle bytes are deterministic and verify to a bounded summary", () => {
  const first = buildPortableEvidenceBundle(fixture());
  const second = buildPortableEvidenceBundle(fixture());

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bundle_sha256, second.bundle_sha256);
  assert.equal(first.bytes.toString("utf8"), canonicalJSONLine(first.value));
  assert.equal(first.bytes.toString("utf8").includes("artifact_root"), false);
  assert.equal(first.bytes.toString("utf8").includes("exported_at"), false);

  const summary = verifyPortableEvidenceBytes(first.bytes);
  assert.deepEqual(summary, {
    verification_status: "portable_evidence_verified",
    bundle_sha256: first.bundle_sha256,
    bundle_bytes: first.bytes.byteLength,
    run_id: "run-portable",
    lifecycle_state: "receipted",
    source_state_sha256: stateSha256,
    executor_kind: "deterministic",
    receipt_sha256: first.receipt_sha256,
    bindings: {
      manifest_sha256: "b".repeat(64),
      workflow_plan_sha256: "c".repeat(64),
      source_snapshot_sha256: "d".repeat(64),
      verification_sha256: first.value.receipt.verification_sha256,
      result_sha256: first.value.receipt.result_sha256,
    },
    verification: {
      adapter_id: "manifest-command",
      status: "passed",
    },
    changes: [{
      path: "src/portable.txt",
      sha256: first.value.result.changes[0].sha256,
    }],
  });
  assert.equal(JSON.stringify(summary).includes("content_base64"), false);
});

test("portable verification translates bundle-controlled contract failures", () => {
  const bundle = buildPortableEvidenceBundle(fixture());
  const cases = [
    Buffer.alloc(0),
    Buffer.from("{}\n", "utf8"),
    Buffer.from("{}", "utf8"),
    Buffer.from("{}\ntrailing", "utf8"),
    Buffer.from("{]\n", "utf8"),
    Buffer.from(`${JSON.stringify(bundle.value, null, 2)}\n`, "utf8"),
    rebuiltValue(bundle.value, { bundle_kind: "wrong" }),
    rebuiltValue(bundle.value, {
      export_context: { ...bundle.value.export_context, state_sha256: "wrong" },
    }),
    rebuiltValue(bundle.value, {
      receipt: withoutField(bundle.value.receipt, "schema_version"),
    }),
    rebuiltValue(bundle.value, {
      result: {
        ...bundle.value.result,
        changes: [{ ...bundle.value.result.changes[0], content_base64: "!" }],
      },
    }),
    rebuiltValue(bundle.value, { receipt_sha256: "e".repeat(64) }),
    rebuildEmbedded(bundle, {
      receipt: { verification_sha256: "e".repeat(64) },
    }),
    rebuildEmbedded(bundle, {
      receipt: { result_sha256: "e".repeat(64) },
    }),
    rebuildEmbedded(bundle, {
      envelope: {
        export_context: {
          ...bundle.value.export_context,
          run_id: "different-run",
        },
      },
    }),
    rebuildEmbedded(bundle, {
      envelope: {
        export_context: {
          ...bundle.value.export_context,
          executor_kind: "codex",
        },
      },
    }),
    rebuildEmbedded(bundle, {
      verification: { ...bundle.value.verification, adapter_id: "" },
    }),
    rebuildEmbedded(bundle, {
      result: {
        ...bundle.value.result,
        changes: [
          bundle.value.result.changes[0],
          bundle.value.result.changes[0],
        ],
      },
    }),
  ];

  for (const field of PORTABLE_EVIDENCE_FIELDS) {
    cases.push(canonicalJSONLineBytes(withoutField(bundle.value, field)));
  }

  for (const bytes of cases) {
    assert.throws(
      () => verifyPortableEvidenceBytes(bytes),
      (error) => error.code === "safety_refusal" && error.exitCode === 3,
    );
  }
});

test("portable verification preserves a structurally valid failed verification", () => {
  const bundle = buildPortableEvidenceBundle(fixture());
  const verification = { ...bundle.value.verification, status: "failed" };
  const receipt = {
    ...bundle.value.receipt,
    verification_sha256: sha256Hex(canonicalJSONLineBytes(verification)),
  };
  const value = {
    ...bundle.value,
    receipt,
    receipt_sha256: sha256Hex(canonicalJSONLineBytes(receipt)),
    verification,
  };

  assert.throws(
    () => verifyPortableEvidenceBytes(canonicalJSONLineBytes(value)),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );
});

test("portable verification rejects invalid UTF-8 before semantic validation", () => {
  const bundle = buildPortableEvidenceBundle(fixture());
  const result = { ...bundle.value.result, run_id: "run-�" };
  const receipt = {
    ...bundle.value.receipt,
    run_id: "run-�",
    result_sha256: sha256Hex(canonicalJSONLineBytes(result)),
  };
  const value = {
    ...bundle.value,
    export_context: { ...bundle.value.export_context, run_id: "run-�" },
    receipt,
    receipt_sha256: sha256Hex(canonicalJSONLineBytes(receipt)),
    result,
  };
  const invalid = replaceReplacementCharactersWithInvalidUtf8(
    canonicalJSONLineBytes(value),
  );

  assert.throws(
    () => verifyPortableEvidenceBytes(invalid),
    (error) =>
      error.code === "safety_refusal" &&
      /valid UTF-8/u.test(error.message),
  );
});

test("portable writer publishes once with private mode and reader is relocatable", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const bundle = buildPortableEvidenceBundle(fixture());
  const firstPath = join(parent, "first.jsonl");
  const secondPath = join(parent, "second.jsonl");

  const first = await writePortableEvidenceBundle(firstPath, bundle.bytes);
  const second = await writePortableEvidenceBundle(secondPath, bundle.bytes);
  assert.equal(first.bundle_sha256, second.bundle_sha256);
  assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
  assert.equal((await lstat(firstPath)).mode & 0o777, 0o600);
  assert.equal((await readPortableEvidenceBundle(firstPath)).run_id, "run-portable");

  await assert.rejects(
    () => writePortableEvidenceBundle(firstPath, bundle.bytes),
    (error) => error.code === "safety_refusal",
  );
  assert.deepEqual(await readFile(firstPath), bundle.bytes);
});

test("portable writer fails closed on target races and injected publication failures", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const bundle = buildPortableEvidenceBundle(fixture());
  const racedPath = join(parent, "raced.jsonl");
  const winner = Buffer.from("concurrent winner\n", "utf8");

  await assert.rejects(
    () => writePortableEvidenceBundle(racedPath, bundle.bytes, {
      async publishLink(source, target) {
        await writeFile(target, winner, { flag: "wx", mode: 0o600 });
        await link(source, target);
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.deepEqual(await readFile(racedPath), winner);

  const writeFailurePath = join(parent, "write-failure.jsonl");
  await assert.rejects(
    () => writePortableEvidenceBundle(writeFailurePath, bundle.bytes, {
      async writeBytes() {
        throw new Error("injected write failure");
      },
    }),
    /injected write failure/,
  );
  await assert.rejects(() => lstat(writeFailurePath), { code: "ENOENT" });

  const linkFailurePath = join(parent, "link-failure.jsonl");
  await assert.rejects(
    () => writePortableEvidenceBundle(linkFailurePath, bundle.bytes, {
      async publishLink() {
        throw new Error("injected link failure");
      },
    }),
    /injected link failure/,
  );
  await assert.rejects(() => lstat(linkFailurePath), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(parent)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("portable writer refuses a parent swap before writing candidate bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const parent = join(root, "parent");
  const moved = join(root, "moved-parent");
  const outside = join(root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  const bundle = buildPortableEvidenceBundle(fixture());

  await assert.rejects(
    () => writePortableEvidenceBundle(join(parent, "bundle.jsonl"), bundle.bytes, {
      async beforeTemporaryOpen() {
        await rename(parent, moved);
        await symlink(outside, parent);
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test("portable writer refuses a parent swap between identity check and temp open", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const parent = join(root, "parent");
  const moved = join(root, "moved-parent");
  const outside = join(root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  const bundle = buildPortableEvidenceBundle(fixture());
  let wroteCandidate = false;

  await assert.rejects(
    () => writePortableEvidenceBundle(join(parent, "bundle.jsonl"), bundle.bytes, {
      async openTemporary(temporaryPath) {
        await rename(parent, moved);
        await symlink(outside, parent);
        return open(temporaryPath, "wx", 0o600);
      },
      async writeBytes(file, bytes) {
        wroteCandidate = true;
        await file.writeFile(bytes);
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.equal(wroteCandidate, false);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test("portable writer scrubs and removes temp after a pre-publication parent swap", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const parent = join(root, "parent");
  const moved = join(root, "moved-parent");
  const outside = join(root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  const bundle = buildPortableEvidenceBundle(fixture());

  await assert.rejects(
    () => writePortableEvidenceBundle(join(parent, "bundle.jsonl"), bundle.bytes, {
      async publishLink() {
        await rename(parent, moved);
        await symlink(outside, parent);
        throw new Error("injected publication failure after parent swap");
      },
    }),
    /injected publication failure/,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test("portable writer scrubs a published inode when its parent swaps", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const parent = join(root, "parent");
  const moved = join(root, "moved-parent");
  const outside = join(root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  const bundle = buildPortableEvidenceBundle(fixture());

  await assert.rejects(
    () => writePortableEvidenceBundle(join(parent, "bundle.jsonl"), bundle.bytes, {
      async publishLink(source, target) {
        await link(source, target);
        await rename(parent, moved);
        await symlink(outside, parent);
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test("portable paths reject symlinks, missing parents, and oversized input", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "believeme-outside-")));
  const redirected = join(parent, "redirected");
  await symlink(outside, redirected);
  const bundle = buildPortableEvidenceBundle(fixture());

  await assert.rejects(
    () => writePortableEvidenceBundle(join(redirected, "bundle.jsonl"), bundle.bytes),
    (error) => error.code === "safety_refusal",
  );

  const existingDirectory = join(parent, "existing-directory");
  await mkdir(existingDirectory);
  await assert.rejects(
    () => writePortableEvidenceBundle(existingDirectory, bundle.bytes),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => readPortableEvidenceBundle(existingDirectory),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => writePortableEvidenceBundle(join(parent, "missing", "bundle.jsonl"), bundle.bytes),
    (error) => error.code === "not_found",
  );

  const source = join(parent, "source.jsonl");
  const alias = join(parent, "alias.jsonl");
  await writePortableEvidenceBundle(source, bundle.bytes);
  const outputAlias = join(parent, "output-alias.jsonl");
  await symlink(source, outputAlias);
  await assert.rejects(
    () => writePortableEvidenceBundle(outputAlias, bundle.bytes),
    (error) => error.code === "safety_refusal",
  );
  await symlink(source, alias);
  await assert.rejects(
    () => readPortableEvidenceBundle(alias),
    (error) => error.code === "safety_refusal",
  );

  const oversized = join(parent, "oversized.jsonl");
  const handle = await open(oversized, "wx", 0o600);
  await handle.truncate(PORTABLE_EVIDENCE_MAX_BYTES + 1);
  await handle.close();
  await chmod(oversized, 0o600);
  await assert.rejects(
    () => readPortableEvidenceBundle(oversized),
    (error) => error.code === "safety_refusal",
  );
});

test("portable reader rejects a file changed after its bounded read", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const bundle = buildPortableEvidenceBundle(fixture());
  const path = join(parent, "changing.jsonl");
  await writePortableEvidenceBundle(path, bundle.bytes);

  await assert.rejects(
    () => readPortableEvidenceBundle(path, {
      async afterRead({ inputPath }) {
        const file = await open(inputPath, "a");
        await file.write("x");
        await file.close();
      },
    }),
    (error) => error.code === "safety_refusal",
  );
});

test("portable reader normalizes disappearance during the read boundary", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  const bundle = buildPortableEvidenceBundle(fixture());
  const path = join(parent, "disappearing.jsonl");
  await writePortableEvidenceBundle(path, bundle.bytes);

  await assert.rejects(
    () => readPortableEvidenceBundle(path, {
      async afterRead({ inputPath }) {
        await unlink(inputPath);
      },
    }),
    (error) => error.code === "not_found" && error.exitCode === 4,
  );
});

test("missing portable input remains not_found", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-portable-")));
  await mkdir(join(parent, "empty"));
  await assert.rejects(
    () => readPortableEvidenceBundle(join(parent, "empty", "missing.jsonl")),
    (error) => error.code === "not_found" && error.exitCode === 4,
  );
});
