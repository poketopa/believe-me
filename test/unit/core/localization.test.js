import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildContextPack,
  canonicalJSONString,
  createProjectSnapshot,
  sha256Hex,
} from "../../../src/index.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "context-pack-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "reservation.js"), [
    "export function reservationCapacity(remainingSeats, requestedSeats) {",
    "  return remainingSeats >= requestedSeats;",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(root, "src", "unicode.js"), "export const 인원 = '예약';\n");
  await writeFile(join(root, "README.md"), "A small booking fixture.\n");
  return root;
}

test("same frozen source task and policy yield byte-identical ContextPack", async () => {
  const root = await project();
  const snapshot = await createProjectSnapshot(root);
  const options = {
    projectRoot: root,
    sourceSnapshot: snapshot,
    task: "Fix reservationCapacity requestedSeats boundary",
  };
  const first = await buildContextPack(options);
  const second = await buildContextPack(options);
  assert.equal(canonicalJSONString(first), canonicalJSONString(second));
  assert.deepEqual(first.entries.map((entry) => entry.path), ["src/reservation.js"]);
  assert.equal(first.selection_status, "matched");
  assert.equal(first.fallback_reason, null);
  assert.equal(first.entries[0].source_sha256, snapshot.entries.find(
    (entry) => entry.path === "src/reservation.js",
  ).sha256);
  const excerpt = first.entries[0].excerpts[0];
  assert.equal(
    sha256Hex(Buffer.from(excerpt.content_base64, "base64")),
    excerpt.sha256,
  );
});

test("ContextPack excludes state, secret content, binary, empty, and oversized files", async () => {
  const root = await project();
  await mkdir(join(root, ".omx"));
  await mkdir(join(root, "generated"));
  await mkdir(join(root, "src", "generated"));
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, ".omx", "state.json"), "state");
  await writeFile(join(root, "generated", "client.js"), "export const generated = true;\n");
  await writeFile(join(root, "src", "generated", "client.js"), "export const generated = true;\n");
  await writeFile(join(root, "evidence", "previous.jsonl"), "{}\n");
  await writeFile(join(root, "credential-source.txt"), "ordinary");
  await writeFile(join(root, "src", "embedded.txt"), 'api_key="abcdefghijklmnop"\n');
  await writeFile(join(root, "src", "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "src", "empty.txt"), "");
  await writeFile(join(root, "src", "large.txt"), "x".repeat(64));
  const snapshot = await createProjectSnapshot(root);
  const pack = await buildContextPack({
    projectRoot: root,
    sourceSnapshot: snapshot,
    task: "unmatched-token",
    policy: {
      max_files: 10,
      max_excerpts: 10,
      max_total_bytes: 100,
      max_file_bytes: 20,
      max_source_file_bytes: 32,
    },
  });
  assert.equal(pack.selection_status, "fallback");
  assert.equal(pack.fallback_reason, "no_match");
  assert.equal(pack.entries.every((entry) => !entry.path.startsWith(".omx/")), true);
  assert.equal(pack.entries.every((entry) => !entry.path.includes("embedded")), true);
  assert.equal(pack.omission_counts.excluded_path, 4);
  assert.equal(pack.omission_counts.secret_content, 1);
  assert.equal(pack.omission_counts.binary, 1);
  assert.equal(pack.omission_counts.empty, 1);
  assert.equal(pack.omission_counts.oversized >= 1, true);
  assert.equal(pack.total_bytes <= 100, true);
  assert.equal(pack.entries.every((entry) => entry.excerpts.reduce(
    (sum, excerpt) => sum + excerpt.end_byte - excerpt.start_byte,
    0,
  ) <= 20), true);
});

test("ContextPack makes budget truncation and no-match fallback explicit", async () => {
  const root = await project();
  const snapshot = await createProjectSnapshot(root);
  const pack = await buildContextPack({
    projectRoot: root,
    sourceSnapshot: snapshot,
    task: "export",
    policy: {
      max_files: 1,
      max_excerpts: 1,
      max_total_bytes: 16,
      max_file_bytes: 16,
      max_source_file_bytes: 4096,
    },
  });
  assert.equal(pack.total_files, 1);
  assert.equal(pack.total_excerpts, 1);
  assert.equal(pack.total_bytes <= 16, true);
  assert.equal(pack.truncated, true);
  assert.deepEqual(pack.truncation_reasons, ["budget_exhausted"]);

  const fallback = await buildContextPack({
    projectRoot: root,
    sourceSnapshot: snapshot,
    task: "zzzz-no-symbol-or-text",
  });
  assert.equal(fallback.selection_status, "fallback");
  assert.equal(fallback.fallback_reason, "no_match");
  assert.equal(fallback.entries[0].reasons[0], "no_match_fallback");
});

test("ContextPack bounds Unicode and rejects snapshot drift and symlinks", async () => {
  const root = await project();
  const snapshot = await createProjectSnapshot(root);
  const unicode = await buildContextPack({
    projectRoot: root,
    sourceSnapshot: snapshot,
    task: "예약 인원",
    policy: {
      max_files: 1,
      max_excerpts: 1,
      max_total_bytes: 17,
      max_file_bytes: 17,
      max_source_file_bytes: 4096,
    },
  });
  const bytes = Buffer.from(unicode.entries[0].excerpts[0].content_base64, "base64");
  assert.equal(bytes.toString("utf8").includes("�"), false);
  assert.equal(bytes.byteLength <= 17, true);

  await writeFile(join(root, "src", "reservation.js"), "changed\n");
  await assert.rejects(
    () => buildContextPack({ projectRoot: root, sourceSnapshot: snapshot, task: "reservation" }),
    (error) => error.code === "safety_refusal",
  );

  const symlinkRoot = await project();
  await symlink(join(symlinkRoot, "README.md"), join(symlinkRoot, "linked.md"));
  await assert.rejects(
    () => createProjectSnapshot(symlinkRoot),
    (error) => error.code === "safety_refusal",
  );
});
