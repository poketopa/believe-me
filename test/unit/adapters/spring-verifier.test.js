import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HERMETIC_REFUSAL_REASON_CODES } from "../../../src/contracts/hermetic-boundary.js";
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

function rootlessOciBoundary() {
  return {
    schema_version: { major: 1 },
    mode: "hermetic",
    backend: {
      kind: "rootless-oci",
      runtime_identity: "podman-5.2.2",
      image_digest: `sha256:${"a".repeat(64)}`,
    },
    platform: { host: "linux", supported_hosts: ["linux"] },
    filesystem: {
      workspace: "read-write",
      root: "read-only",
      host_home: "denied",
      runtime_socket: "denied",
    },
    network: { mode: "none", ambient_egress: "denied" },
    toolchain: { downloads: "denied", mutable_cache: "denied" },
    cleanup: { owner: "backend", residue: "denied" },
    refusal_reason_codes: [...HERMETIC_REFUSAL_REASON_CODES],
  };
}

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

test("hermetic Spring verifier uses only the inspected Podman backend and cleans it", async () => {
  const root = await fixtureRoot();
  const inspected = await podmanCapability();
  const backendCalls = [];
  const spawnCalls = [];

  const result = await runSpringVerifier({
    fixtureRoot: root,
    hermeticBoundary: rootlessOciBoundary(),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    backendExecFile: successfulBackendExec(backendCalls),
    nameFactory: () => "believe-me-verifier",
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return childProcess({ stdout: "ok\n" });
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, inspected.executable);
  assert.deepEqual(spawnCalls[0].args.slice(0, 8), [
    "run",
    "--name",
    "believe-me-verifier",
    "--rm",
    "--init",
    "--pull=never",
    "--network",
    "none",
  ]);
  assert.equal(spawnCalls[0].args.includes("./gradlew"), true);
  assert.deepEqual(spawnCalls[0].options.env, {
    LC_ALL: "C",
    PATH: `${join(inspected.executable, "..")}:/usr/bin:/bin`,
  });
  assert.equal(Object.hasOwn(spawnCalls[0].options.env, "GITHUB_TOKEN"), false);
  assert.equal(result.adapter_id, SPRING_VERIFIER_ADAPTER_ID);
  assert.deepEqual(result.argv, [
    "./gradlew",
    "--no-daemon",
    "--console=plain",
    "-q",
    "test",
  ]);
  assert.equal(backendCalls.some((args) => args[0] === "rm"), true);
  assert.equal(backendCalls.some((args) => args[0] === "ps"), true);
});

test("hermetic Spring refusal occurs before spawn with no direct fallback", async () => {
  const root = await fixtureRoot();
  let spawnCount = 0;

  await assert.rejects(
    runSpringVerifier({
      fixtureRoot: root,
      hermeticBoundary: rootlessOciBoundary(),
      hostPlatform: "linux",
      inspectBackend: async () => ({ available: false }),
      spawnImpl() {
        spawnCount += 1;
        return childProcess();
      },
    }),
    (error) => error.code === "safety_refusal" &&
      error.details.refusal.code === "backend_missing",
  );
  assert.equal(spawnCount, 0);
});

test("hermetic Spring timeout invokes backend-owned cleanup", async () => {
  const root = await fixtureRoot();
  const inspected = await podmanCapability();
  const backendCalls = [];

  await assert.rejects(
    runSpringVerifier({
      fixtureRoot: root,
      hermeticBoundary: rootlessOciBoundary(),
      hostPlatform: "linux",
      inspectBackend: async () => inspected,
      backendExecFile: successfulBackendExec(backendCalls),
      nameFactory: () => "believe-me-verifier",
      timeoutMs: 1,
      spawnImpl() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal) => {
          child.emit("close", null, signal);
          return true;
        };
        return child;
      },
    }),
    (error) => error.code === "verification_failed" &&
      error.details.result.timed_out === true,
  );
  assert.equal(backendCalls.some((args) => args[0] === "rm"), true);
  assert.equal(backendCalls.some((args) => args[0] === "ps"), true);
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

test("spring verifier terminates on parent abort", async () => {
  const root = await fixtureRoot();
  const controller = new AbortController();
  let killedWith;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const running = runSpringVerifier({
    fixtureRoot: root,
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

async function podmanCapability() {
  const root = await mkdtemp(join(tmpdir(), "spring-podman-"));
  const executable = join(root, "podman");
  await writeFile(executable, "podman");
  await chmod(executable, 0o755);
  const stats = await lstat(executable, { bigint: true });
  return {
    available: true,
    executable,
    runtime_identity: "podman-5.2.2",
    host_platform: "linux",
    file_identity: {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      size: stats.size.toString(),
      modified_ns: stats.mtimeNs.toString(),
    },
  };
}

function successfulBackendExec(calls) {
  return (_command, args, _options, callback) => {
    calls.push([...args]);
    if (args[0] === "ps") {
      callback(null, "", "");
      return;
    }
    callback(null, "", "");
  };
}

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}
