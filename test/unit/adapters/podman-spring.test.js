import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HERMETIC_REFUSAL_REASON_CODES } from "../../../src/contracts/hermetic-boundary.js";
import {
  inspectPodmanBackend,
  preparePodmanSpringInvocation,
} from "../../../src/adapters/podman-spring.js";

const verifierDigest = `sha256:${"a".repeat(64)}`;
const serviceDigest = `sha256:${"b".repeat(64)}`;
const helpOutput = [
  "--cap-drop",
  "--env",
  "--filter",
  "--force",
  "--format",
  "--ignore",
  "--init",
  "--internal",
  "--name",
  "--network",
  "--pids-limit",
  "--pull",
  "--read-only",
  "--rm",
  "--security-opt",
  "--tmpfs",
  "--userns",
  "--volume",
  "--workdir",
].join(" ");
const fixture = Object.freeze({
  verifier: {
    command: "./gradlew",
    args: ["--no-daemon", "--console=plain", "-q", "test"],
  },
});

function boundary(overrides = {}) {
  return {
    schema_version: { major: 1 },
    mode: "hermetic",
    backend: {
      kind: "rootless-oci",
      runtime_identity: "podman-5.2.2",
      image_digest: verifierDigest,
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

async function executable() {
  const root = await mkdtemp(join(tmpdir(), "podman-spring-"));
  const path = join(root, "podman");
  await writeFile(path, "podman");
  await chmod(path, 0o755);
  return path;
}

async function availableFromFile() {
  const path = await executable();
  const resolved = await realpath(path);
  const inspected = await inspectPodmanBackend({
    executable: path,
    hostPlatform: "linux",
    execFileImpl(command, args, _options, callback) {
      assert.equal(command, resolved);
      const key = args.join(" ");
      if (key === "--version") callback(null, "podman version 5.2.2\n", "");
      else if (key === "info --format json") {
        callback(null, JSON.stringify({ host: { os: "linux", security: { rootless: true } } }), "");
      } else callback(null, helpOutput, "");
    },
  });
  assert.equal(inspected.available, true);
  return inspected;
}

function fakeExec(calls, missing = new Set(), residue = false) {
  return (command, args, _options, callback) => {
    calls.push([command, [...args]]);
    const key = args.join(" ");
    if (missing.has(key)) {
      const error = new Error("missing");
      error.code = "ENOENT";
      callback(error, "", "");
      return;
    }
    if (key.startsWith("ps --all")) {
      callback(null, residue ? "believe-me-verifier\n" : "", "");
      return;
    }
    if (key.startsWith("network exists")) {
      const error = new Error("no network");
      error.code = 1;
      callback(error, "", "");
      return;
    }
    callback(null, "", "");
  };
}

test("podman Spring network-none invocation freezes exact no-pull restricted argv", async () => {
  const inspected = await availableFromFile();
  const calls = [];
  const invocation = await preparePodmanSpringInvocation({
    boundary: boundary(),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    root: "/fixture",
    fixture,
    execFileImpl: fakeExec(calls),
    nameFactory: () => "believe-me-verifier",
  });

  assert.equal(invocation.command, inspected.executable);
  assert.deepEqual(calls.map(([, args]) => args), [["image", "exists", verifierDigest]]);
  assert.deepEqual(invocation.args, [
    "run",
    "--name", "believe-me-verifier",
    "--rm",
    "--init",
    "--pull=never",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--cap-drop", "all",
    "--security-opt", "no-new-privileges",
    "--userns", "keep-id",
    "--pids-limit", "512",
    "--volume", "/fixture:/workspace:rw",
    "--workdir", "/workspace",
    "--env", "CI=true",
    "--env", "HOME=/workspace",
    "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env", "TMPDIR=/tmp",
    "--env", "GRADLE_USER_HOME=/tmp/gradle",
    "--env", "GRADLE_OPTS=-Dorg.gradle.offline=true -Dorg.gradle.daemon=false",
    verifierDigest,
    "./gradlew",
    "--no-daemon",
    "--console=plain",
    "-q",
    "test",
  ]);
  assert.deepEqual(invocation.env, {
    LC_ALL: "C",
    PATH: `${dirname(inspected.executable)}:/usr/bin:/bin`,
  });
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.isFrozen(invocation.args), true);
  assert.equal(typeof invocation.cleanup, "function");
});

test("podman preparation refuses unsupported host/backend/runtime/image before verifier spawn", async () => {
  const inspected = await availableFromFile();
  const cases = [
    {
      options: { boundary: boundary(), hostPlatform: "win32", inspectBackend: async () => inspected },
      code: "platform_unsupported",
    },
    {
      options: {
        boundary: boundary({
          backend: { kind: "bubblewrap", runtime_identity: "bwrap-0.11.2", image_digest: null },
        }),
        hostPlatform: "linux",
        inspectBackend: async () => inspected,
      },
      code: "backend_unsupported",
    },
    {
      options: { boundary: boundary(), hostPlatform: "linux", inspectBackend: async () => ({ available: false }) },
      code: "backend_missing",
    },
    {
      options: {
        boundary: boundary(),
        hostPlatform: "linux",
        inspectBackend: async () => ({ ...inspected, runtime_identity: "podman-5.2.3" }),
      },
      code: "runtime_identity_mismatch",
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      preparePodmanSpringInvocation({
        ...item.options,
        root: "/fixture",
        fixture,
        execFileImpl: fakeExec([]),
      }),
      (error) => error.code === "safety_refusal" && error.details.refusal.code === item.code,
    );
  }

  await assert.rejects(
    preparePodmanSpringInvocation({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => inspected,
      root: "/fixture",
      fixture,
      execFileImpl: fakeExec([], new Set([`image exists ${verifierDigest}`])),
    }),
    (error) => error.details.refusal.code === "image_unavailable",
  );
  await assert.rejects(
    preparePodmanSpringInvocation({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => ({
        available: false,
        unavailable_reason: "cleanup_unavailable",
      }),
      root: "/fixture",
      fixture,
      execFileImpl: fakeExec([]),
    }),
    (error) => error.details.refusal.code === "cleanup_unavailable",
  );
});

test("podman inspection gates Linux rootless runtime and required flags", async () => {
  const path = await executable();
  const resolved = await realpath(path);
  const calls = [];
  const inspected = await inspectPodmanBackend({
    executable: path,
    hostPlatform: "linux",
    execFileImpl(command, args, options, callback) {
      calls.push(args.join(" "));
      assert.equal(command, resolved);
      assert.equal(options.env.LC_ALL, "C");
      if (args.join(" ") === "--version") callback(null, "podman version 5.2.2\n", "");
      else if (args.join(" ") === "info --format json") {
        callback(null, JSON.stringify({ host: { os: "linux", security: { rootless: true } } }), "");
      } else callback(null, helpOutput, "");
    },
  });

  assert.equal(inspected.available, true);
  assert.equal(inspected.runtime_identity, "podman-5.2.2");
  assert.equal(calls.includes("run --help"), true);

  const unsupported = await inspectPodmanBackend({
    executable: path,
    hostPlatform: "linux",
    execFileImpl(_command, args, _options, callback) {
      if (args.join(" ") === "--version") callback(null, "podman version 5.2.2\n", "");
      else if (args.join(" ") === "info --format json") {
        callback(null, JSON.stringify({ host: { os: "darwin", security: { rootless: false } } }), "");
      } else callback(null, "--cap-drop", "");
    },
  });
  assert.deepEqual(unsupported, { available: false });
});

test("podman inspection gates macOS VM as running and rootless", async () => {
  const path = await executable();
  const inspected = await inspectPodmanBackend({
    executable: path,
    hostPlatform: "darwin",
    execFileImpl(_command, args, _options, callback) {
      const key = args.join(" ");
      if (key === "--version") callback(null, "podman version 5.2.2\n", "");
      else if (key === "info --format json") {
        callback(null, JSON.stringify({ host: { os: "linux", security: { rootless: true } } }), "");
      } else if (key === "machine inspect --format json") {
        callback(null, JSON.stringify([{ State: "running", Rootful: false }]), "");
      } else callback(null, helpOutput, "");
    },
  });
  assert.equal(inspected.available, true);

  const refused = await inspectPodmanBackend({
    executable: path,
    hostPlatform: "darwin",
    execFileImpl(_command, args, _options, callback) {
      if (args.join(" ") === "--version") callback(null, "podman version 5.2.2\n", "");
      else if (args.join(" ") === "info --format json") {
        callback(null, JSON.stringify({ host: { os: "linux", security: { rootless: true } } }), "");
      } else if (args.join(" ") === "machine inspect --format json") {
        callback(null, JSON.stringify([{ State: "stopped", Rootful: false }]), "");
      } else callback(null, helpOutput, "");
    },
  });
  assert.deepEqual(refused, { available: false });
});

test("podman service network is internal, bounded, ready, and injected into verifier", async () => {
  const inspected = await availableFromFile();
  const calls = [];
  const names = { verifier: "believe-me-verifier", service: "believe-me-service", network: "believe-me-net" };
  const invocation = await preparePodmanSpringInvocation({
    boundary: boundary({
      backend: {
        kind: "rootless-oci",
        runtime_identity: "podman-5.2.2",
        image_digest: verifierDigest,
        service_image_digest: serviceDigest,
      },
      network: { mode: "isolated-service", ambient_egress: "denied" },
    }),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    root: "/fixture",
    fixture,
    execFileImpl: fakeExec(calls),
    nameFactory: (role) => names[role],
  });

  assert.deepEqual(calls.map(([, args]) => args), [
    ["image", "exists", verifierDigest],
    ["image", "exists", serviceDigest],
    ["network", "create", "--internal", "believe-me-net"],
    [
      "run", "--detach", "--name", "believe-me-service", "--pull=never",
      "--network", "believe-me-net", "--read-only",
      "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m",
      "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=32m",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
      "--cap-drop", "all", "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--env", "POSTGRES_DB=verifier",
      "--env", "POSTGRES_USER=verifier",
      "--env", "POSTGRES_PASSWORD=verifier-password",
      serviceDigest,
    ],
    ["exec", "believe-me-service", "pg_isready", "-U", "verifier", "-d", "verifier"],
  ]);
  assert.equal(invocation.args.includes("--network"), true);
  assert.equal(invocation.args[invocation.args.indexOf("--network") + 1], "believe-me-net");
  assert.equal(invocation.args.includes("SPRING_DATASOURCE_URL=jdbc:postgresql://believe-me-service:5432/verifier"), true);
  assert.equal(invocation.args.includes("SPRING_DATASOURCE_USERNAME=verifier"), true);
  assert.equal(invocation.args.includes("SPRING_DATASOURCE_PASSWORD=verifier-password"), true);

  await assert.rejects(
    preparePodmanSpringInvocation({
      boundary: boundary({
        backend: {
          kind: "rootless-oci",
          runtime_identity: "podman-5.2.2",
          image_digest: verifierDigest,
          service_image_digest: serviceDigest,
        },
        network: { mode: "isolated-service", ambient_egress: "denied" },
      }),
      hostPlatform: "linux",
      inspectBackend: async () => ({ ...inspected, service_network_available: false }),
      root: "/fixture",
      fixture,
      execFileImpl: fakeExec([]),
      nameFactory: (role) => names[role],
    }),
    (error) => error.details.refusal.code === "network_policy_unsupported",
  );

  const failureCalls = [];
  await assert.rejects(
    preparePodmanSpringInvocation({
      boundary: boundary({
        backend: {
          kind: "rootless-oci",
          runtime_identity: "podman-5.2.2",
          image_digest: verifierDigest,
          service_image_digest: serviceDigest,
        },
        network: { mode: "isolated-service", ambient_egress: "denied" },
      }),
      hostPlatform: "linux",
      inspectBackend: async () => inspected,
      root: "/fixture",
      fixture,
      execFileImpl: fakeExec(failureCalls, new Set([
        [
          "run", "--detach", "--name", "believe-me-service", "--pull=never",
          "--network", "believe-me-net", "--read-only",
          "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m",
          "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=32m",
          "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
          "--cap-drop", "all", "--security-opt", "no-new-privileges",
          "--pids-limit", "256",
          "--env", "POSTGRES_DB=verifier",
          "--env", "POSTGRES_USER=verifier",
          "--env", "POSTGRES_PASSWORD=verifier-password",
          serviceDigest,
        ].join(" "),
      ])),
      nameFactory: (role) => names[role],
    }),
    (error) => error.code === "infra_error",
  );
  assert.deepEqual(failureCalls.map(([, args]) => args).slice(-1), [
    ["network", "rm", "believe-me-net"],
  ]);
});

test("podman cleanup removes exact names and refuses residue", async () => {
  const inspected = await availableFromFile();
  const calls = [];
  const invocation = await preparePodmanSpringInvocation({
    boundary: boundary(),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    root: "/fixture",
    fixture,
    execFileImpl: fakeExec(calls),
    nameFactory: () => "believe-me-verifier",
  });
  assert.deepEqual(await invocation.cleanup(), { residue: false });
  assert.deepEqual(calls.slice(1).map(([, args]) => args), [
    ["rm", "--force", "--ignore", "believe-me-verifier"],
    ["ps", "--all", "--filter", "name=^believe-me-verifier$", "--format", "{{.Names}}"],
  ]);

  const residueCalls = [];
  const residueInvocation = await preparePodmanSpringInvocation({
    boundary: boundary(),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    root: "/fixture",
    fixture,
    execFileImpl: fakeExec(residueCalls, new Set(), true),
    nameFactory: () => "believe-me-verifier",
  });
  await assert.rejects(
    residueInvocation.cleanup(),
    (error) => error.code === "safety_refusal" &&
      error.details.refusal.code === "cleanup_unavailable",
  );

  const networkCalls = [];
  const networkNames = {
    verifier: "believe-me-verifier",
    service: "believe-me-service",
    network: "believe-me-net",
  };
  const networkInvocation = await preparePodmanSpringInvocation({
    boundary: boundary({
      backend: {
        kind: "rootless-oci",
        runtime_identity: "podman-5.2.2",
        image_digest: verifierDigest,
        service_image_digest: serviceDigest,
      },
      network: { mode: "isolated-service", ambient_egress: "denied" },
    }),
    hostPlatform: "linux",
    inspectBackend: async () => inspected,
    root: "/fixture",
    fixture,
    execFileImpl(command, args, options, callback) {
      if (args.join(" ") === "network exists believe-me-net") {
        networkCalls.push([command, [...args]]);
        const error = new Error("podman inspection failed");
        error.code = 2;
        callback(error, "", "");
        return;
      }
      fakeExec(networkCalls)(command, args, options, callback);
    },
    nameFactory: (role) => networkNames[role],
  });
  await assert.rejects(
    networkInvocation.cleanup(),
    (error) => error.code === "infra_error" &&
      error.message === "Podman cleanup network residue inspection failed.",
  );
});

test("podman backend has no Docker fallback and refuses executable drift", async () => {
  const inspected = await availableFromFile();
  await writeFile(inspected.executable, "changed");
  const calls = [];
  await assert.rejects(
    preparePodmanSpringInvocation({
      boundary: boundary(),
      hostPlatform: "linux",
      inspectBackend: async () => inspected,
      root: "/fixture",
      fixture,
      execFileImpl: fakeExec(calls),
      nameFactory: () => "believe-me-verifier",
    }),
    (error) => error.details.refusal.code === "runtime_identity_mismatch",
  );
  assert.equal(calls.length, 0);
});
