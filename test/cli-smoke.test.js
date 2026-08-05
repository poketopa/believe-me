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
