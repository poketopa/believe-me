#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createCodexExecutor } from "../src/adapters/codex-executor.js";
import { validateCodexTaskInput } from "../src/contracts/codex-executor.js";
import { canonicalJSONLine } from "../src/core/canonical-json.js";
import { runHarness } from "../src/core/run-orchestrator.js";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const canonicalRoot = resolve(
  "test/fixtures/roomescape-cancel-booking-penalty",
);
const projectRoot = await mkdtemp(join(tmpdir(), "vah-live-codex-project-"));
const controlRoot = await mkdtemp(join(tmpdir(), "vah-live-codex-control-"));
await cp(canonicalRoot, projectRoot, { recursive: true, force: true });

const targetPath =
  "src/main/java/com/roomescape/booking/application/ReservationService.java";
const correctSource = await readFile(join(canonicalRoot, targetPath), "utf8");
const baselineSource = correctSource.replace(
  "if (!now.isBefore(deadline))",
  "if (now.isAfter(deadline))",
);
if (baselineSource === correctSource) {
  throw new Error("Live smoke baseline mutation was not created.");
}
await writeFile(join(projectRoot, targetPath), baselineSource);

const manifestPath = join(controlRoot, "skill.json");
const inputPath = join(controlRoot, "input.json");
await writeJson(manifestPath, {
  schema_version: { major: 1 },
  manifest_id: "roomescape-codex-live-smoke",
  name: "Roomescape Codex live smoke",
  policy_id: "roomescape-cancellation-boundary",
  executor_kinds: ["codex"],
  input_schema_ref: "codex-executor-input/v1",
  policy_rules: { max_changes: 1 },
});
await writeJson(inputPath, {
  task: [
    "Fix the owner cancellation deadline boundary.",
    "An owner may cancel only when the current instant is strictly before",
    "the reservation start instant minus 30 minutes.",
    "At the exact deadline and after it, cancellation must be refused.",
    "Make the smallest implementation-only change and preserve all other behavior.",
  ].join(" "),
  allowed_paths: [targetPath],
});

const completed = await runHarness({
  runId: `live-codex-${Date.now()}`,
  runSpec: {
    schema_version: { major: 1 },
    project_path: projectRoot,
    state_dir: join(projectRoot, ".harness"),
    skill_manifest_path: manifestPath,
    input_path: inputPath,
    executor_kind: "codex",
  },
  executorInputValidator: validateCodexTaskInput,
  executor: createCodexExecutor(),
});

if (await readFile(join(projectRoot, targetPath), "utf8") !== baselineSource) {
  throw new Error("Live Codex smoke mutated source before approval.");
}

process.stdout.write(canonicalJSONLine({
  schema_version: { major: 1 },
  status: "receipted",
  run_id: completed.state.run_id,
  receipt_sha256: completed.state.receipt_sha256,
  changed_paths: completed.evidence.result.changes.map((change) => change.path),
  usage: completed.evidence.result.executor_evidence.usage,
  project_path: projectRoot,
  source_unchanged: true,
}));
