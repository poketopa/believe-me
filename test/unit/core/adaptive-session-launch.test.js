import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { adaptiveSessionPaths } from "../../../src/core/adaptive-session.js";
import { canonicalJSONLine } from "../../../src/core/canonical-json.js";
import {
  sha256CanonicalJSON,
  sha256CanonicalJSONLine,
  sha256Hex,
} from "../../../src/core/hash.js";
import {
  adaptiveSessionLaunchPaths,
  readAdaptiveSessionLaunch,
  readBoundAdaptiveSessionLaunch,
  writeAdaptiveSessionLaunch,
} from "../../../src/core/adaptive-session-launch.js";

const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));

function contextPack() {
  const bytes = Buffer.from("export const value = 1;\n", "utf8");
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
      path: "src/app.js",
      source_sha256: digest("source"),
      reasons: ["text_match"],
      excerpts: [{
        start_byte: 0,
        end_byte: bytes.byteLength,
        content_base64: bytes.toString("base64"),
        sha256: sha256Hex(bytes),
        reasons: ["text_match"],
      }],
    }],
  };
}

function policy() {
  return {
    schema_version: { major: 1 },
    policy_id: "launch-policy",
    attempt_budget: 2,
    token_budget: 1000,
    wall_budget_ms: 60_000,
    routes: [{
      route_id: "codex-initial",
      reason: "initial",
      adapter_id: "codex-cli",
      model_id: "gpt-5.5",
      reasoning_effort: "medium",
      timeout_ms: 30_000,
    }],
  };
}

function launchValue(stateDir, sessionId = "session-launch", overrides = {}) {
  const pack = contextPack();
  const skillManifest = {
    schema_version: { major: 1 },
    manifest_id: "launch-skill",
    name: "Launch skill",
    policy_id: "launch-policy",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task/v1",
    policy_rules: {},
  };
  const taskInput = {
    task: "Change src/app.js.",
    allowed_paths: ["src/app.js"],
    context_pack: pack,
  };
  const executionPolicy = policy();
  return {
    schema_version: { major: 1 },
    session_id: sessionId,
    project_path: resolve("/tmp/launch-project"),
    state_dir: resolve(stateDir),
    skill_manifest: skillManifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(skillManifest),
    task_input: taskInput,
    task_input_sha256: sha256CanonicalJSON(taskInput),
    policy: executionPolicy,
    policy_sha256: sha256CanonicalJSON(executionPolicy),
    context_pack: pack,
    context_pack_sha256: sha256CanonicalJSON(pack),
    risk_tier: "low",
    transient_infra_retry_codes: ["ECONNRESET"],
    adapter_id: "codex-cli",
    ...overrides,
  };
}

function adaptiveInput(launch, overrides = {}) {
  return {
    schema_version: { major: 1 },
    session_id: launch.session_id,
    policy: launch.policy,
    policy_sha256: launch.policy_sha256,
    context_pack: launch.context_pack,
    context_pack_sha256: launch.context_pack_sha256,
    transient_infra_retry_codes: launch.transient_infra_retry_codes,
    launch_sha256: sha256CanonicalJSONLine(launch),
    ...overrides,
  };
}

async function writePair(paths, value) {
  const line = canonicalJSONLine(value);
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  await mkdir(dirname(paths.body), { recursive: true, mode: 0o700 });
  await writeFile(paths.body, line, { encoding: "utf8", mode: 0o600 });
  await writeFile(paths.digest, `${sha256}\n`, { encoding: "utf8", mode: 0o600 });
  return sha256;
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
}

test("launch persistence publishes canonical private pair once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const paths = adaptiveSessionPaths(stateDir, "session-launch");
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const launch = launchValue(stateDir);

  const written = await writeAdaptiveSessionLaunch(paths, launch);
  const launchPaths = adaptiveSessionLaunchPaths(paths);

  assert.equal(written.sha256, sha256CanonicalJSONLine(launch));
  assert.equal(await readFile(launchPaths.body, "utf8"), canonicalJSONLine(written.launch));
  assert.equal(await readFile(launchPaths.digest, "utf8"), `${written.sha256}\n`);
  assert.equal((await lstat(launchPaths.body)).mode & 0o777, 0o600);
  assert.equal((await lstat(launchPaths.digest)).mode & 0o777, 0o600);

  await assert.rejects(
    writeAdaptiveSessionLaunch(paths, launch),
    /already exists/u,
  );
});

test("read launch refuses partial tampered noncanonical symlink and root mismatch", async () => {
  const partialStateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const partialPaths = adaptiveSessionPaths(partialStateDir, "partial");
  await mkdir(partialPaths.root, { recursive: true });
  await writeFile(adaptiveSessionLaunchPaths(partialPaths).body, "{}\n");
  await assert.rejects(
    readAdaptiveSessionLaunch(partialPaths),
    (error) => error.code === "safety_refusal",
  );

  const tamperStateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const tamperPaths = adaptiveSessionPaths(tamperStateDir, "session-launch");
  await mkdir(tamperPaths.root, { recursive: true });
  await writeAdaptiveSessionLaunch(tamperPaths, launchValue(tamperStateDir));
  const tamperLaunchPaths = adaptiveSessionLaunchPaths(tamperPaths);
  await writeFile(tamperLaunchPaths.body, `${await readFile(tamperLaunchPaths.body, "utf8")} `);
  await assert.rejects(readAdaptiveSessionLaunch(tamperPaths), /digest|JSON line/u);

  const noncanonicalStateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const noncanonicalPaths = adaptiveSessionPaths(noncanonicalStateDir, "noncanonical");
  await mkdir(noncanonicalPaths.root, { recursive: true });
  const noncanonical = launchValue(noncanonicalStateDir, "noncanonical");
  const line = `${JSON.stringify(noncanonical)}\n`;
  await writeFile(adaptiveSessionLaunchPaths(noncanonicalPaths).body, line);
  await writeFile(
    adaptiveSessionLaunchPaths(noncanonicalPaths).digest,
    `${sha256Hex(Buffer.from(line, "utf8"))}\n`,
  );
  await assert.rejects(readAdaptiveSessionLaunch(noncanonicalPaths), /canonical JSONL/u);

  const symlinkStateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const symlinkPaths = adaptiveSessionPaths(symlinkStateDir, "symlink");
  const outside = join(await mkdtemp(join(tmpdir(), "launch-outside-")), "launch.jsonl");
  await mkdir(symlinkPaths.root, { recursive: true });
  await writeFile(outside, canonicalJSONLine(launchValue(symlinkStateDir, "symlink")));
  await symlink(outside, adaptiveSessionLaunchPaths(symlinkPaths).body);
  await writeFile(adaptiveSessionLaunchPaths(symlinkPaths).digest, `${digest("wrong")}\n`);
  await assert.rejects(readAdaptiveSessionLaunch(symlinkPaths), /regular file|symlink/u);

  const rootStateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const rootPaths = adaptiveSessionPaths(rootStateDir, "root-link");
  await mkdir(join(rootStateDir, "sessions"), { recursive: true });
  await symlink(await mkdtemp(join(tmpdir(), "launch-outside-root-")), rootPaths.root);
  await assert.rejects(readAdaptiveSessionLaunch(rootPaths), /real directory/u);
});

test("bound launch reader allows legacy reads but refuses launch-less resume gates", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const paths = adaptiveSessionPaths(stateDir, "legacy");
  const launch = launchValue(stateDir, "legacy");
  await mkdir(paths.root, { recursive: true });

  assert.equal(await readAdaptiveSessionLaunch(paths, { required: false }), null);
  assert.equal(await readBoundAdaptiveSessionLaunch(paths, adaptiveInput(launch, {
    launch_sha256: undefined,
  })), null);
  await assert.rejects(
    readBoundAdaptiveSessionLaunch(paths, adaptiveInput(launch, {
      launch_sha256: undefined,
    }), { requireBinding: true }),
    (error) => error.code === "safety_refusal" || error.code === "not_found",
  );
});

test("bound launch reader rejects input digest and launch digest drift", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const paths = adaptiveSessionPaths(stateDir, "session-launch");
  const launch = launchValue(stateDir);
  await mkdir(paths.root, { recursive: true });
  const written = await writeAdaptiveSessionLaunch(paths, launch);

  await assert.doesNotReject(readBoundAdaptiveSessionLaunch(paths, adaptiveInput(written.launch)));
  await assert.rejects(
    readBoundAdaptiveSessionLaunch(paths, adaptiveInput(written.launch, {
      launch_sha256: digest("0"),
    })),
    /launch digest/u,
  );
  await assert.rejects(
    readBoundAdaptiveSessionLaunch(paths, adaptiveInput(written.launch, {
      policy_sha256: digest("1"),
    })),
    /launch|authority/u,
  );
});

test("concurrent launch writes admit exactly one writer", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "launch-state-"));
  const paths = adaptiveSessionPaths(stateDir, "session-launch");
  const launch = launchValue(stateDir);
  await mkdir(paths.root, { recursive: true });
  const results = await Promise.allSettled([
    writeAdaptiveSessionLaunch(paths, launch),
    writeAdaptiveSessionLaunch(paths, launch),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("no-create launch read leaves missing state absent", async () => {
  const stateDir = join(tmpdir(), `launch-missing-${Date.now()}`);
  await rm(stateDir, { recursive: true, force: true });
  const paths = adaptiveSessionPaths(stateDir, "missing");

  await assert.rejects(
    readAdaptiveSessionLaunch(paths),
    (error) => error.code === "ENOENT" || error.code === "not_found",
  );
  await assertMissing(stateDir);
});
