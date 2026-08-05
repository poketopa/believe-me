import assert from "node:assert/strict";
import test from "node:test";
import {
  infraError,
  notFound,
  safetyRefusal,
  usageError,
  verificationFailed,
} from "../../src/contracts/errors.js";
import { runCli } from "../../src/cli/main.js";

function sink() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    read: () => value,
  };
}

function assertOneJsonLine(value) {
  assert.equal(value.endsWith("\n"), true);
  assert.equal(value.slice(0, -1).includes("\n"), false);
  return JSON.parse(value);
}

test("runCli emits one canonical success JSONL record", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli(["init"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    executeCliCommand: async () => ({ state_dir: "/project/.harness" }),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(assertOneJsonLine(stdout.read()), {
    command: "init",
    data: { state_dir: "/project/.harness" },
    schema_version: { major: 1 },
    status: "ok",
  });
});

const failures = [
  [usageError("bad usage"), 2, "usage_error"],
  [safetyRefusal("unsafe"), 3, "safety_refusal"],
  [notFound("missing"), 4, "not_found"],
  [verificationFailed("failed"), 5, "verification_failed"],
  [infraError("offline"), 10, "infra_error"],
];

for (const [error, expectedExit, expectedCode] of failures) {
  test(`runCli maps ${expectedCode} to exit ${expectedExit}`, async () => {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await runCli(["init"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      executeCliCommand: async () => { throw error; },
    });

    assert.equal(exitCode, expectedExit);
    assert.equal(stdout.read(), "");
    const payload = assertOneJsonLine(stderr.read());
    assert.equal(payload.command, "init");
    assert.equal(payload.status, "error");
    assert.equal(payload.error.code, expectedCode);
  });
}

test("runCli maps unexpected errors to sanitized infra_error", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli(["init"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    executeCliCommand: async () => { throw new Error("secret stack data"); },
  });

  assert.equal(exitCode, 10);
  const payload = assertOneJsonLine(stderr.read());
  assert.equal(payload.error.code, "infra_error");
  assert.equal(payload.error.message, "Unexpected harness error.");
  assert.doesNotMatch(stderr.read(), /secret stack data/);
});

test("help and version remain plain text", async () => {
  const help = sink();
  assert.equal(await runCli(["--help"], { stdout: help.stream }), 0);
  assert.match(help.read(), /^BelieveMe \(@poketopa\/believe-me\)/);
  assert.match(help.read(), /believeme run/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(help.read())));

  const version = sink();
  assert.equal(await runCli(["--version"], { stdout: version.stream }), 0);
  assert.equal(version.read(), "0.0.0-development\n");
});
