import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  COMMAND_VERIFIER_ADAPTER_ID,
  runCommandVerifier,
} from "../../../src/adapters/command-verifier.js";
import { sha256Hex } from "../../../src/index.js";

const spec = Object.freeze({
  schema_version: { major: 1 },
  adapter_id: "command-verifier",
  command: "node",
  args: ["--version"],
  timeout_ms: 1_000,
  max_output_bytes: 1024,
});

test("command verifier spawns exact argv directly without shell", async () => {
  const root = await projectRoot();
  const calls = [];

  const result = await runCommandVerifier({
    projectRoot: root,
    spec,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return childProcess({ stdout: "ok\n", stderr: "warn\n" });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.cwd, await realpath(root));
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.detached, process.platform !== "win32");
  assert.equal(calls[0].options.env.CI, "true");
  assert.equal(Object.hasOwn(calls[0].options.env, "GITHUB_TOKEN"), false);
  assert.deepEqual(result, {
    schema_version: { major: 1 },
    adapter_id: COMMAND_VERIFIER_ADAPTER_ID,
    argv: ["node", "--version"],
    status: "passed",
    exit_code: 0,
    signal: null,
    timed_out: false,
    output_truncated: false,
    stdout_sha256: sha256Hex(Buffer.from("ok\n")),
    stderr_sha256: sha256Hex(Buffer.from("warn\n")),
  });
  assertFrozenTree(result);
  assert.equal(Object.hasOwn(result, "stdout"), false);
  assert.equal(Object.hasOwn(result, "stderr"), false);
});

test("command verifier validates project root and spec", async () => {
  const root = await projectRoot();

  await assert.rejects(
    () => runCommandVerifier({ projectRoot: join(root, "missing"), spec }),
    (error) => error.code === "infra_error" && error.exitCode === 10,
  );

  await assert.rejects(
    () => runCommandVerifier({
      projectRoot: root,
      spec: { ...spec, adapter_id: "other" },
      spawnImpl: childProcess,
    }),
    /adapter_id/,
  );

  await assert.rejects(
    () => runCommandVerifier({
      projectRoot: root,
      spec: { ...spec, args: ["ok", 1] },
      spawnImpl: childProcess,
    }),
    (error) => {
      assert.equal(error.code, "usage_error");
      assert.match(error.message, /args/);
      return true;
    },
  );

  await assert.rejects(
    () => runCommandVerifier({
      projectRoot: root,
      spec: { ...spec, timeout_ms: 0 },
      spawnImpl: childProcess,
    }),
    (error) => {
      assert.equal(error.code, "usage_error");
      assert.match(error.message, /timeout_ms/);
      return true;
    },
  );
});

test("command verifier rejects symlinked project-relative executables", async () => {
  const root = await projectRoot();
  const outside = await mkdtemp(join(tmpdir(), "command-verifier-outside-"));
  await writeFile(join(outside, "verify"), "#!/bin/sh\nexit 0\n");
  await mkdir(join(root, "tools"));
  await symlink(join(outside, "verify"), join(root, "tools", "verify"));

  await assert.rejects(
    () => runCommandVerifier({
      projectRoot: root,
      spec: { ...spec, command: "./tools/verify", args: [] },
    }),
    (error) => {
      assert.equal(error.code, "safety_refusal");
      assert.match(error.message, /symbolic links/);
      return true;
    },
  );
});

test("command verifier maps nonzero exit to verification_failed with result details", async () => {
  const root = await projectRoot();

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec,
        spawnImpl: () =>
          childProcess({ stdout: "tests failed", stderr: "boom", exitCode: 7 }),
      }),
    (error) => {
      assert.equal(error.code, "verification_failed");
      assert.equal(error.exitCode, 5);
      assert.equal(error.details.stdout, "tests failed");
      assert.equal(error.details.stderr, "boom");
      assert.equal(error.details.result.status, "failed");
      assert.equal(error.details.result.exit_code, 7);
      assert.equal(error.details.result.signal, null);
      assert.equal(error.details.result.output_truncated, false);
      return true;
    },
  );
});

test("command verifier terminates on timeout", async () => {
  const root = await projectRoot();
  let killedWith;

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec: { ...spec, timeout_ms: 1 },
        spawnImpl() {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = (signal) => {
            killedWith = signal;
            child.emit("close", null, signal);
            return true;
          };
          return child;
        },
      }),
    (error) => {
      assert.equal(error.code, "verification_failed");
      assert.equal(error.details.result.status, "failed");
      assert.equal(error.details.result.exit_code, null);
      assert.equal(error.details.result.signal, "SIGTERM");
      assert.equal(error.details.result.timed_out, true);
      return true;
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("command verifier terminates on parent abort", async () => {
  const root = await projectRoot();
  const controller = new AbortController();
  let killedWith;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const running = runCommandVerifier({
    projectRoot: root,
    spec,
    signal: controller.signal,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        killedWith = signal;
        child.emit("close", null, signal);
        return true;
      };
      markStarted();
      return child;
    },
  });
  await started;
  controller.abort();
  await assert.rejects(running, (error) => {
    assert.equal(error.code, "verification_failed");
    assert.equal(error.details.result.signal, "SIGTERM");
    assert.equal(error.details.result.timed_out, false);
    return true;
  });
  assert.equal(killedWith, "SIGTERM");
});

test("command verifier fails closed when the child ignores termination", async () => {
  const root = await projectRoot();
  const signals = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec: { ...spec, timeout_ms: 1 },
        spawnImpl() {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = (signal) => {
            signals.push(signal);
            return true;
          };
          child.unref = () => {};
          return child;
        },
    }),
    (error) => {
      assert.equal(error.code, "infra_error");
      assert.equal(error.details.process_residue, true);
      return true;
    },
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - startedAt < 3_000);
});

test("command verifier bounds combined output and reports truncation", async () => {
  const root = await projectRoot();
  let killedWith;

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec: { ...spec, max_output_bytes: 5 },
        spawnImpl() {
          const child = childProcess({ stdout: "abcdef", exitCode: 1 });
          const kill = child.kill.bind(child);
          child.kill = (signal) => {
            killedWith = signal;
            return kill(signal);
          };
          return child;
        },
      }),
    (error) => {
      assert.equal(error.code, "verification_failed");
      assert.equal(error.details.stdout, "abcde");
      assert.equal(error.details.stderr, "");
      assert.equal(error.details.result.output_truncated, true);
      assert.equal(error.details.result.stdout_sha256, sha256Hex(Buffer.from("abcde")));
      return true;
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("command verifier maps sync spawn failure to infra_error", async () => {
  const root = await projectRoot();

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec,
        spawnImpl() {
          const error = new Error("missing binary");
          error.code = "ENOENT";
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.code, "infra_error");
      assert.equal(error.exitCode, 10);
      assert.equal(error.details.cause_code, "ENOENT");
      return true;
    },
  );
});

test("command verifier maps async process failure to infra_error", async () => {
  const root = await projectRoot();

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec,
        spawnImpl() {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          queueMicrotask(() => {
            const error = new Error("process failed");
            error.code = "EACCES";
            child.emit("error", error);
          });
          return child;
        },
      }),
    (error) => {
      assert.equal(error.code, "infra_error");
      assert.equal(error.exitCode, 10);
      assert.equal(error.details.cause_code, "EACCES");
      return true;
    },
  );
});

test("command verifier cleans a surviving verifier process group before passing", async () => {
  const root = await projectRoot();
  const processGroupEnabled = process.platform !== "win32";
  let groupAlive = processGroupEnabled;
  const signals = [];

  const result = await runCommandVerifier({
    projectRoot: root,
    spec,
    spawnImpl() {
      const child = childProcess();
      child.pid = 42_424;
      return child;
    },
    processKill(pid, signal) {
      assert.equal(pid, -42_424);
      signals.push(signal);
      if (signal === 0) {
        if (groupAlive) {
          return;
        }
        const error = new Error("missing process group");
        error.code = "ESRCH";
        throw error;
      }
      groupAlive = false;
    },
  });

  assert.equal(result.status, "passed");
  if (processGroupEnabled) {
    assert.deepEqual(signals, [0, "SIGTERM", 0, 0]);
  } else {
    assert.deepEqual(signals, []);
  }
});

test(
  "command verifier cleans a real long-lived descendant process",
  { skip: process.platform === "win32" },
  async () => {
    const root = await projectRoot();
    const pidPath = join(root, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync('descendant.pid', String(child.pid));",
      "child.unref();",
    ].join(" ");

    const result = await runCommandVerifier({
      projectRoot: root,
      spec: { ...spec, args: ["--eval", script] },
    });

    assert.equal(result.status, "passed");
    const descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error.code === "ESRCH",
    );
  },
);

test("command verifier rejects invalid child process objects", async () => {
  const root = await projectRoot();

  await assert.rejects(
    () =>
      runCommandVerifier({
        projectRoot: root,
        spec,
        spawnImpl: () => ({}),
      }),
    (error) => {
      assert.equal(error.code, "usage_error");
      assert.equal(error.exitCode, 2);
      assert.equal(error.details.field, "spawnImpl");
      return true;
    },
  );
});

async function projectRoot() {
  return mkdtemp(join(tmpdir(), "command-verifier-"));
}

function childProcess({ stdout = "", stderr = "", exitCode = 0, signal = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (killSignal) => {
    child.killed = true;
    child.emit("close", null, killSignal);
    return true;
  };
  queueMicrotask(() => {
    if (stdout.length > 0) {
      child.stdout.write(stdout);
    }
    if (stderr.length > 0) {
      child.stderr.write(stderr);
    }
    if (!child.killed) {
      child.emit("close", exitCode, signal);
    }
  });
  return child;
}

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}
