import assert from "node:assert/strict";
import test from "node:test";
import {
  HERMETIC_REFUSAL_REASON_CODES,
  validateHermeticBoundary,
  validateHermeticBoundaryRefusal,
} from "../../../src/contracts/hermetic-boundary.js";
import { sha256CanonicalJSONLine } from "../../../src/core/hash.js";

function boundary(overrides = {}) {
  return {
    schema_version: { major: 1 },
    mode: "hermetic",
    backend: {
      kind: "bubblewrap",
      runtime_identity: "bwrap-0.11.0",
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

test("hermetic boundary validates and deeply freezes explicit sandbox authority", () => {
  const value = validateHermeticBoundary(boundary());

  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.backend), true);
  assert.equal(Object.isFrozen(value.platform.supported_hosts), true);
  assert.equal(value.mode, "hermetic");
  assert.match(sha256CanonicalJSONLine(value), /^[a-f0-9]{64}$/u);
});

test("hermetic boundary accepts immutable rootless OCI identity", () => {
  const value = validateHermeticBoundary(boundary({
    backend: {
      kind: "rootless-oci",
      runtime_identity: "podman-5.2.2",
      image_digest: `sha256:${"a".repeat(64)}`,
    },
    platform: { host: "darwin", supported_hosts: ["darwin", "linux"] },
    network: { mode: "isolated-service", ambient_egress: "denied" },
  }));

  assert.equal(value.backend.kind, "rootless-oci");
  assert.equal(value.platform.host, "darwin");
});

test("hermetic boundary rejects unknown metadata and unsupported capability drift", () => {
  assert.throws(
    () => validateHermeticBoundary(boundary({ route_id: "adaptive-route" })),
    /unsupported fields/u,
  );
  assert.throws(
    () => validateHermeticBoundary(boundary({
      platform: { host: "win32", supported_hosts: ["win32"] },
    })),
    /unsupported value/u,
  );
  assert.throws(
    () => validateHermeticBoundary(boundary({
      backend: {
        kind: "rootless-oci",
        runtime_identity: "podman-5.2.2",
        image_digest: "latest",
      },
    })),
    /immutable image digest/u,
  );
  assert.throws(
    () => validateHermeticBoundary(boundary({
      network: { mode: "isolated-service", ambient_egress: "denied" },
    })),
    /service networking/u,
  );
});

test("hermetic refusal evidence is typed bounded and safe to persist", () => {
  const value = validateHermeticBoundaryRefusal({
    schema_version: { major: 1 },
    status: "refused",
    code: "platform_unsupported",
    backend_kind: null,
    host_platform: "win32",
    message: "No supported hermetic backend is configured for this host.",
  });

  assert.equal(Object.isFrozen(value), true);
  assert.throws(
    () => validateHermeticBoundaryRefusal({
      ...value,
      message: "raw env follows\nTOKEN=secret",
    }),
    /bounded single-line/u,
  );
  assert.throws(
    () => validateHermeticBoundaryRefusal({ ...value, code: "spawn_failed" }),
    /unsupported value/u,
  );
});
