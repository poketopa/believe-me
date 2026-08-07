import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../bin/believeme.js", import.meta.url);

test("CLI exposes the working product identity", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "0.3.0\n");
});

test("CLI documents the current command surface", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^BelieveMe \(@poketopa\/believe-me\)/);
  for (const command of [
    "demo",
    "init",
    "run",
    "status",
    "receipt",
    "review",
    "status-session",
    "review-session",
    "export-bundle",
    "verify-bundle",
    "apply",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});
