import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildContextPack,
  contextPackArtifactPaths,
  createProjectSnapshot,
  readContextPackArtifact,
  writeContextPackArtifact,
} from "../../../src/index.js";

test("ContextPack artifact round-trips as canonical JSONL with digest sidecar", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "context-artifact-source-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "context-artifact-output-"));
  await writeFile(join(projectRoot, "source.js"), "export const answer = 42;\n");
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  const contextPack = await buildContextPack({
    projectRoot,
    sourceSnapshot,
    task: "change answer",
  });
  const written = await writeContextPackArtifact(artifactRoot, contextPack);
  const read = await readContextPackArtifact(artifactRoot);
  assert.deepEqual(read.value, contextPack);
  assert.equal(read.sha256, written.sha256);

  const paths = contextPackArtifactPaths(artifactRoot);
  await writeFile(paths.digest, `${"0".repeat(64)}\n`);
  await assert.rejects(
    () => readContextPackArtifact(artifactRoot),
    (error) => error.code === "safety_refusal",
  );
});
