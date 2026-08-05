import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../bin/verifiable-agent-harness.js", import.meta.url);

test("CLI exposes the working product identity", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "0.0.0-development\n");
});

test("CLI documents the v0.1 command surface", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  for (const command of ["init", "run", "status", "receipt", "apply"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("CLI reports the reserved Codex route as a typed unavailable adapter", () => {
  const result = spawnSync(process.execPath, [
    cli.pathname,
    "run",
    "--project",
    ".",
    "--skill",
    "skill.json",
    "--executor",
    "codex",
    "--input",
    "input.json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 10);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.endsWith("\n"), true);
  assert.equal(result.stderr.slice(0, -1).includes("\n"), false);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.command, "run");
  assert.equal(payload.status, "error");
  assert.equal(payload.error.code, "infra_error");
  assert.equal(payload.error.details.executor_kind, "codex");
});
