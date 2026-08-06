import assert from "node:assert/strict";
import test from "node:test";
import { createManifestVerifier } from "../../../src/adapters/manifest-verifier.js";
import { HERMETIC_REFUSAL_REASON_CODES } from "../../../src/contracts/hermetic-boundary.js";

const schema_version = { major: 1 };

function manifest(overrides = {}) {
  return {
    schema_version,
    manifest_id: "manifest-verifier-test",
    name: "Manifest verifier test",
    policy_id: "test-policy",
    executor_kinds: ["deterministic"],
    input_schema_ref: "deterministic-executor-input/v1",
    policy_rules: {},
    ...overrides,
  };
}

function hermeticBoundary() {
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
  };
}

function rootlessOciBoundary() {
  return {
    ...hermeticBoundary(),
    backend: {
      kind: "rootless-oci",
      runtime_identity: "podman-5.2.2",
      image_digest: `sha256:${"a".repeat(64)}`,
    },
    platform: { host: "linux", supported_hosts: ["linux"] },
  };
}

test("manifest verifier routes explicit command specs with frozen argv", async () => {
  let observed;
  const verifier = createManifestVerifier(manifest({
    verifier: {
      schema_version,
      adapter_id: "command-verifier",
      command: "node",
      args: ["--test"],
      timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    },
  }), {
    async runCommandVerifier(options) {
      observed = options;
      return { status: "passed" };
    },
    runSpringVerifier: async () => assert.fail("Spring fallback must not run"),
  });

  assert.deepEqual(await verifier({ workspaceRoot: "/workspace" }), {
    status: "passed",
  });
  assert.equal(observed.projectRoot, "/workspace");
  assert.equal(observed.spec.adapter_id, "command-verifier");
  assert.equal(Object.isFrozen(observed.spec), true);
});

test("legacy v1 manifests retain the explicit Spring compatibility route", async () => {
  let fixtureRoot;
  const verifier = createManifestVerifier(manifest(), {
    runCommandVerifier: async () => assert.fail("Command verifier must not run"),
    async runSpringVerifier(options) {
      fixtureRoot = options.fixtureRoot;
      return { status: "passed", adapter_id: "spring-verifier" };
    },
  });

  const result = await verifier({ projectRoot: "/legacy-spring" });
  assert.equal(fixtureRoot, "/legacy-spring");
  assert.equal(result.adapter_id, "spring-verifier");
});

test("manifest composition carries explicit hermetic authority to command verifier", async () => {
  const boundary = hermeticBoundary();
  let observed;
  const verifier = createManifestVerifier(manifest({
    verifier: {
      schema_version,
      adapter_id: "command-verifier",
      command: "node",
      args: ["--test"],
      timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    },
  }), {
    hermeticBoundary: boundary,
    hostPlatform: "linux",
    inspectBackend: async () => ({ available: false }),
    async runCommandVerifier(options) {
      observed = options;
      return { status: "passed" };
    },
  });

  await verifier({ workspaceRoot: "/workspace" });
  assert.deepEqual(observed.hermeticBoundary, boundary);
  assert.equal(Object.isFrozen(observed.hermeticBoundary), true);
  assert.equal(observed.hostPlatform, "linux");
  assert.equal(typeof observed.inspectBackend, "function");
});

test("manifest composition carries frozen rootless OCI authority only to Spring verifier", async () => {
  const boundary = rootlessOciBoundary();
  const inspectSpringBackend = async () => ({ available: false });
  const backendExecFile = async () => ({ stdout: "", stderr: "" });
  const nameFactory = () => "fixed-name";
  let observed;
  const verifier = createManifestVerifier(manifest(), {
    hermeticBoundary: boundary,
    hostPlatform: "linux",
    inspectSpringBackend,
    backendExecFile,
    nameFactory,
    runCommandVerifier: async () => assert.fail("Command verifier must not run"),
    async runSpringVerifier(options) {
      observed = options;
      return { status: "passed" };
    },
  });

  await verifier({ workspaceRoot: "/workspace" });
  assert.deepEqual(observed.hermeticBoundary, boundary);
  assert.equal(Object.isFrozen(observed.hermeticBoundary), true);
  assert.equal(observed.hostPlatform, "linux");
  assert.equal(observed.inspectBackend, inspectSpringBackend);
  assert.equal(observed.backendExecFile, backendExecFile);
  assert.equal(observed.nameFactory, nameFactory);
});
