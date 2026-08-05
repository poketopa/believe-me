import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDeterministicChanges,
  createIsolatedWorkspace,
  createProjectSnapshot,
  sha256Hex,
  validateDeterministicExecutorResult,
} from "../../../src/index.js";

function change(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

test("isolated workspace copies admitted files and preserves executable mode", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-workspace-project-"));
  const workspaceParent = await mkdtemp(join(tmpdir(), "vah-workspace-state-"));
  const workspaceRoot = join(workspaceParent, "workspace");
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src", "app.txt"), "source");
  await writeFile(join(projectRoot, "run.sh"), "#!/bin/sh\n");
  await chmod(join(projectRoot, "run.sh"), 0o755);
  await mkdir(join(projectRoot, "build"));
  await writeFile(join(projectRoot, "build", "ignored.txt"), "ignored");

  const snapshot = await createProjectSnapshot(projectRoot);
  const created = await createIsolatedWorkspace({
    projectRoot,
    workspaceRoot,
    expectedSnapshotSha256: snapshot.sha256,
  });

  assert.equal(created.source_snapshot_sha256, snapshot.sha256);
  assert.equal(await readFile(join(workspaceRoot, "src", "app.txt"), "utf8"), "source");
  assert.equal((await stat(join(workspaceRoot, "run.sh"))).mode & 0o777, 0o755);
  await assert.rejects(() => readFile(join(workspaceRoot, "build", "ignored.txt")));
});

test("deterministic changes produce an apply-compatible non-empty result", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vah-workspace-"));
  await mkdir(join(workspaceRoot, "src"));
  await writeFile(join(workspaceRoot, "src", "app.txt"), "source");
  const candidate = change("src/app.txt", "candidate");

  const result = await applyDeterministicChanges({
    workspaceRoot,
    executorInput: {
      schema_version: { major: 1 },
      run_id: "run-1",
      manifest_sha256: "a".repeat(64),
      source_snapshot_sha256: "b".repeat(64),
      executor_kind: "deterministic",
      input: { changes: [candidate] },
    },
    validateResult: validateDeterministicExecutorResult,
  });

  assert.deepEqual(result.changes, [candidate]);
  assert.equal(await readFile(join(workspaceRoot, "src", "app.txt"), "utf8"), "candidate");
});

test("workspace creation refuses symlinked admitted source", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-workspace-project-"));
  const workspaceParent = await mkdtemp(join(tmpdir(), "vah-workspace-state-"));
  await writeFile(join(projectRoot, "target.txt"), "target");
  await symlink(join(projectRoot, "target.txt"), join(projectRoot, "link.txt"));

  await assert.rejects(
    () => createIsolatedWorkspace({
      projectRoot,
      workspaceRoot: join(workspaceParent, "workspace"),
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("deterministic changes refuse symlinked parent directories", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vah-workspace-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "vah-workspace-outside-"));
  await symlink(outsideRoot, join(workspaceRoot, "linkdir"));
  const escaped = change("linkdir/pwn.txt", "escaped");

  await assert.rejects(
    () => applyDeterministicChanges({
      workspaceRoot,
      executorInput: {
        schema_version: { major: 1 },
        run_id: "run-1",
        manifest_sha256: "a".repeat(64),
        source_snapshot_sha256: "b".repeat(64),
        executor_kind: "deterministic",
        input: { changes: [escaped] },
      },
      validateResult: validateDeterministicExecutorResult,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  await assert.rejects(() => readFile(join(outsideRoot, "pwn.txt")));
});
