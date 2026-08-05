import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compareCodeUnit,
  createProjectSnapshot,
  normalizeRelativePath,
} from "../../../src/index.js";

async function tempProject() {
  return mkdtemp(join(tmpdir(), "vah-snapshot-"));
}

test("project snapshot hashes sorted admitted regular files only", async () => {
  const root = await tempProject();
  await writeFile(join(root, "b.txt"), "b");
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, "api-token.txt"), "token");

  const first = await createProjectSnapshot(root);
  const second = await createProjectSnapshot(root);

  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    ["a.txt", "b.txt"],
  );
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});

test("snapshot ordering is locale-independent code-unit ordering", async () => {
  const root = await tempProject();
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "B.txt"), "B");
  await writeFile(join(root, "á.txt"), "accent");

  const previousLocale = process.env.LC_ALL;
  process.env.LC_ALL = "sv_SE.UTF-8";
  try {
    const snapshot = await createProjectSnapshot(root);
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.path),
      ["B.txt", "a.txt", "á.txt"].sort(compareCodeUnit),
    );
  } finally {
    if (previousLocale === undefined) {
      delete process.env.LC_ALL;
    } else {
      process.env.LC_ALL = previousLocale;
    }
  }
});

test("project snapshot refuses symlinks in admitted scope", async () => {
  const root = await tempProject();
  await writeFile(join(root, "target.txt"), "target");
  await symlink(join(root, "target.txt"), join(root, "link.txt"));

  await assert.rejects(
    () => createProjectSnapshot(root),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("path normalization enforces inside-root relative paths", async () => {
  const root = await tempProject();
  assert.equal(normalizeRelativePath(root, "./src/../file.txt"), "file.txt");
  assert.throws(
    () => normalizeRelativePath(root, "../escape.txt"),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.throws(
    () => normalizeRelativePath(root, resolve(root, "file.txt")),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});
