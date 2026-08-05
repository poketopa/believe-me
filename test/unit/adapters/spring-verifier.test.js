import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  SPRING_VERIFIER_ADAPTER_ID,
  runSpringVerifier,
  sha256Hex,
} from "../../../src/index.js";

const fixture = {
  schema_version: { major: 1 },
  fixture_id: "spring-fixture",
  verifier: {
    command: "./gradlew",
    args: ["--no-daemon", "--console=plain", "-q", "test"],
  },
};

test("spring verifier spawns exact argv directly without shell", async () => {
  const root = await fixtureRoot();
  const calls = [];

  const result = await runSpringVerifier({
    fixtureRoot: root,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return childProcess({ stdout: "ok\n", stderr: "warn\n" });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "./gradlew");
  assert.deepEqual(calls[0].args, ["--no-daemon", "--console=plain", "-q", "test"]);
  assert.equal(calls[0].options.cwd, await realpath(root));
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.env.CI, "true");
  assert.equal(Object.hasOwn(calls[0].options.env, "GITHUB_TOKEN"), false);
  assert.deepEqual(result, {
    schema_version: { major: 1 },
    fixture_id: "spring-fixture",
    adapter_id: SPRING_VERIFIER_ADAPTER_ID,
    argv: ["./gradlew", "--no-daemon", "--console=plain", "-q", "test"],
    status: "passed",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stdout_sha256: sha256Hex(Buffer.from("ok\n")),
    stderr_sha256: sha256Hex(Buffer.from("warn\n")),
  });
  assertFrozenTree(result);
  assert.equal(Object.hasOwn(result, "duration_ms"), false);
  assert.equal(Object.hasOwn(result, "stdout"), false);
  assert.equal(Object.hasOwn(result, "stderr"), false);
});

test("spring verifier validates fixture schema and exact command", async () => {
  const root = await fixtureRoot({
    schema_version: { major: 2 },
    fixture_id: "spring-fixture",
    verifier: {
      command: "./gradlew",
      args: ["--no-daemon", "--console=plain", "-q", "test"],
    },
  });

  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: root, spawnImpl: childProcess }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );

  await writeFixture(root, {
    ...fixture,
    verifier: { command: "gradle", args: ["test"] },
  });
  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: root, spawnImpl: childProcess }),
    /verifier.command must be exactly/,
  );

  await writeFixture(root, {
    ...fixture,
    verifier: { command: "./gradlew", args: [] },
  });
  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: root, spawnImpl: childProcess }),
    /verifier.args must be a non-empty string array/,
  );

  await writeFixture(root, {
    ...fixture,
    verifier: { command: "./gradlew", args: ["test"] },
  });
  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: root, spawnImpl: childProcess }),
    /do not match the canonical Spring verifier argv/,
  );
});

test("spring verifier rejects symlink, non-regular, and non-executable wrappers", async () => {
  const symlinkRoot = await fixtureRoot(undefined, { wrapper: false });
  await writeFile(join(symlinkRoot, "outside"), "#!/bin/sh\n");
  await symlink(join(symlinkRoot, "outside"), join(symlinkRoot, "gradlew"));
  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: symlinkRoot, spawnImpl: childProcess }),
    /must not be a symlink/,
  );

  const directoryRoot = await fixtureRoot(undefined, { wrapper: false });
  await mkdir(join(directoryRoot, "gradlew"));
  await assert.rejects(
    () => runSpringVerifier({ fixtureRoot: directoryRoot, spawnImpl: childProcess }),
    /must be a regular file/,
  );

  const nonExecutableRoot = await fixtureRoot(undefined, { executable: false });
  await assert.rejects(
    () => runSpringVerifier({
      fixtureRoot: nonExecutableRoot,
      spawnImpl: childProcess,
    }),
    /must be executable/,
  );
});

test("spring verifier bounds output and reports bounded verification failure", async () => {
  const root = await fixtureRoot();
  let killedWith;

  await assert.rejects(
    () =>
      runSpringVerifier({
        fixtureRoot: root,
        maxOutputBytes: 5,
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
      assert.equal(error.exitCode, 5);
      assert.equal(error.details.stdout, "abcde");
      assert.equal(error.details.stderr, "");
      assert.equal(error.details.output_truncated, true);
      assert.equal(error.details.result.stdout_sha256, sha256Hex(Buffer.from("abcde")));
      return true;
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("spring verifier terminates on timeout", async () => {
  const root = await fixtureRoot();
  let killedWith;

  await assert.rejects(
    () =>
      runSpringVerifier({
        fixtureRoot: root,
        timeoutMs: 1,
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
      assert.equal(error.exitCode, 5);
      assert.equal(error.details.result.status, "failed");
      assert.equal(error.details.result.exit_code, null);
      assert.equal(error.details.result.signal, "SIGTERM");
      assert.equal(error.details.result.timed_out, true);
      return true;
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("spring verifier force-settles when the child ignores termination", async () => {
  const root = await fixtureRoot();
  const signals = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runSpringVerifier({
        fixtureRoot: root,
        timeoutMs: 1,
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
      assert.equal(error.code, "verification_failed");
      assert.equal(error.details.result.timed_out, true);
      assert.equal(error.details.result.signal, "SIGKILL");
      return true;
    },
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - startedAt < 3_000);
});

test("spring verifier maps nonzero exit to verification_failed with bounded raw details", async () => {
  const root = await fixtureRoot();

  await assert.rejects(
    () =>
      runSpringVerifier({
        fixtureRoot: root,
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
      return true;
    },
  );
});

test("spring verifier maps process start errors to infra_error", async () => {
  const root = await fixtureRoot();

  await assert.rejects(
    () =>
      runSpringVerifier({
        fixtureRoot: root,
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

async function fixtureRoot(value = fixture, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "spring-verifier-"));
  await writeFixture(root, value);
  if (options.wrapper !== false) {
    await writeFile(join(root, "gradlew"), "#!/bin/sh\nexit 0\n");
    if (options.executable !== false) {
      await chmod(join(root, "gradlew"), 0o755);
    } else {
      await chmod(join(root, "gradlew"), 0o644);
    }
  }
  return root;
}

async function writeFixture(root, value) {
  await writeFile(join(root, "fixture.json"), `${JSON.stringify(value)}\n`);
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
