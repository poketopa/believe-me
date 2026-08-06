import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HERMETIC_REFUSAL_REASON_CODES } from "../../../src/contracts/hermetic-boundary.js";
import {
  inspectBubblewrapBackend,
  prepareBubblewrapCommand,
} from "../../../src/adapters/bubblewrap-command.js";

const spec = Object.freeze({
  command: "./tools/verify",
  args: ["--strict"],
});

function boundary(overrides = {}) {
  return {
    schema_version: { major: 1 },
    mode: "hermetic",
    backend: {
      kind: "bubblewrap",
      runtime_identity: "bwrap-0.11.2",
      image_digest: null,
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
    ...overrides,
  };
}

const available = async () => ({
  available: true,
  executable: "/usr/bin/bwrap",
  runtime_identity: "bwrap-0.11.2",
});

test("bubblewrap invocation freezes the explicit hermetic namespace policy", async () => {
  const invocation = await prepareBubblewrapCommand({
    boundary: boundary(),
    hostPlatform: "linux",
    inspectBackend: available,
    root: "/project",
    spec,
  });

  assert.equal(invocation.command, "/usr/bin/bwrap");
  assert.deepEqual(invocation.args, [
    "--die-with-parent", "--new-session",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-net",
    "--unshare-uts", "--disable-userns", "--clearenv",
    "--setenv", "CI", "true",
    "--setenv", "HOME", "/nonexistent",
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "TMPDIR", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/workspace", "--bind", "/project", "/workspace",
    "--chdir", "/workspace", "--", "/workspace/tools/verify", "--strict",
  ]);
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.isFrozen(invocation.args), true);
});

test("bubblewrap preparation refuses unsupported hosts and backends before inspection", async () => {
  let inspected = false;
  for (const [value, code] of [
    [{ hostPlatform: "darwin", boundary: boundary() }, "platform_unsupported"],
    [{
      hostPlatform: "linux",
      boundary: boundary({
        backend: {
          kind: "rootless-oci",
          runtime_identity: "podman-5.2.2",
          image_digest: `sha256:${"a".repeat(64)}`,
        },
      }),
    }, "backend_unsupported"],
  ]) {
    await assert.rejects(
      prepareBubblewrapCommand({
        ...value,
        root: "/project",
        spec,
        inspectBackend: async () => {
          inspected = true;
          return { available: true };
        },
      }),
      (error) => error.code === "safety_refusal" && error.details.refusal.code === code,
    );
  }
  assert.equal(inspected, false);
});

test("bubblewrap preparation refuses missing and drifted runtime capability", async () => {
  await assert.rejects(
    prepareBubblewrapCommand({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => ({ available: false }),
      root: "/project",
      spec,
    }),
    (error) => error.details.refusal.code === "backend_missing",
  );
  await assert.rejects(
    prepareBubblewrapCommand({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => ({
        available: true,
        executable: "/usr/bin/bwrap",
        runtime_identity: "bwrap-0.11.3",
      }),
      root: "/project",
      spec,
    }),
    (error) => error.details.refusal.code === "runtime_identity_mismatch",
  );
});

test("bubblewrap inspection accepts only an executable with exact bounded version output", async () => {
  const root = await mkdtemp(join(tmpdir(), "bubblewrap-inspect-"));
  const executable = join(root, "bwrap");
  await writeFile(executable, "binary");
  await chmod(executable, 0o755);
  const inspected = await inspectBubblewrapBackend({
    executable,
    execFileImpl(command, args, options, callback) {
      assert.equal(command, executable);
      assert.equal(options.env.LC_ALL, "C");
      if (args[0] === "--version") {
        callback(null, "bubblewrap 0.11.2\n", "");
        return;
      }
      callback(null, [
        "--clearenv", "--die-with-parent", "--disable-userns", "--new-session",
        "--unshare-ipc", "--unshare-net", "--unshare-pid", "--unshare-user",
        "--unshare-uts",
      ].join(" "), "");
    },
  });
  assert.equal(inspected.available, true);
  assert.equal(inspected.executable, executable);
  assert.equal(inspected.runtime_identity, "bwrap-0.11.2");
  assert.deepEqual(Object.keys(inspected.file_identity), [
    "device", "inode", "size", "modified_ns",
  ]);

  await chmod(executable, 0o600);
  assert.deepEqual(await inspectBubblewrapBackend({ executable }), { available: false });
});

test("bubblewrap inspection refuses releases below the security floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "bubblewrap-obsolete-"));
  const executable = join(root, "bwrap");
  await writeFile(executable, "binary");
  await chmod(executable, 0o755);

  const inspected = await inspectBubblewrapBackend({
    executable,
    execFileImpl(_command, args, _options, callback) {
      if (args[0] === "--version") {
        callback(null, "bubblewrap 0.11.1\n", "");
        return;
      }
      callback(null, [
        "--clearenv", "--die-with-parent", "--disable-userns", "--new-session",
        "--unshare-ipc", "--unshare-net", "--unshare-pid", "--unshare-user",
        "--unshare-uts",
      ].join(" "), "");
    },
  });

  assert.deepEqual(inspected, { available: false });
});

test("bubblewrap preparation refuses executable identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "bubblewrap-drift-"));
  const executable = join(root, "bwrap");
  await writeFile(executable, "binary");
  await chmod(executable, 0o755);
  const inspected = await inspectBubblewrapBackend({
    executable,
    execFileImpl(_command, args, _options, callback) {
      callback(null, args[0] === "--version"
        ? "bubblewrap 0.11.2\n"
        : [
          "--clearenv", "--die-with-parent", "--disable-userns", "--new-session",
          "--unshare-ipc", "--unshare-net", "--unshare-pid", "--unshare-user",
          "--unshare-uts",
        ].join(" "), "");
    },
  });
  await writeFile(executable, "changed executable bytes");

  await assert.rejects(
    prepareBubblewrapCommand({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => inspected,
      root: "/project",
      spec,
    }),
    (error) => error.details.refusal.code === "runtime_identity_mismatch",
  );
});
