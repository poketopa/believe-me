import {
  assertEnum,
  assertRequiredFields,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";

export const HERMETIC_BACKEND_KINDS = Object.freeze([
  "bubblewrap",
  "rootless-oci",
]);

export const HERMETIC_SUPPORTED_HOSTS = Object.freeze([
  "darwin",
  "linux",
]);

export const HERMETIC_REFUSAL_HOSTS = Object.freeze([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);

export const HERMETIC_REFUSAL_REASON_CODES = Object.freeze([
  "backend_missing",
  "backend_unsupported",
  "boundary_digest_mismatch",
  "boundary_invalid",
  "cleanup_unavailable",
  "image_unavailable",
  "network_policy_unsupported",
  "platform_unsupported",
  "runtime_identity_mismatch",
]);

const BOUNDARY_FIELDS = Object.freeze([
  "schema_version",
  "mode",
  "backend",
  "platform",
  "filesystem",
  "network",
  "toolchain",
  "cleanup",
  "refusal_reason_codes",
]);

const REFUSAL_FIELDS = Object.freeze([
  "schema_version",
  "status",
  "code",
  "backend_kind",
  "host_platform",
  "message",
]);

const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const OCI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function assertExactFields(value, fields, label) {
  const unsupported = Object.keys(value).filter((field) => !fields.includes(field));
  if (unsupported.length > 0) {
    throw usageError(`${label} contains unsupported fields.`, {
      fields: unsupported.sort(),
    });
  }
}

function validateBackend(value) {
  const requiredFields = ["kind", "runtime_identity", "image_digest"];
  const fields = [...requiredFields, "service_image_digest"];
  assertRequiredFields(value, requiredFields, "HermeticBoundary backend");
  assertExactFields(value, fields, "HermeticBoundary backend");
  assertEnum(value.kind, "backend.kind", HERMETIC_BACKEND_KINDS);
  assertString(value.runtime_identity, "backend.runtime_identity");
  if (!SAFE_IDENTITY_PATTERN.test(value.runtime_identity)) {
    throw usageError("backend.runtime_identity must be a bounded safe identifier.", {
      field: "backend.runtime_identity",
    });
  }
  if (value.kind === "bubblewrap" && value.image_digest !== null) {
    throw usageError("bubblewrap boundaries must not declare an OCI image digest.");
  }
  if (value.kind === "bubblewrap" && value.service_image_digest !== undefined) {
    throw usageError("bubblewrap boundaries must not declare an OCI service image digest.");
  }
  if (value.kind === "rootless-oci" && !OCI_DIGEST_PATTERN.test(value.image_digest ?? "")) {
    throw usageError("rootless-oci boundaries require an immutable image digest.", {
      field: "backend.image_digest",
    });
  }
  if (
    value.service_image_digest !== undefined &&
    !OCI_DIGEST_PATTERN.test(value.service_image_digest)
  ) {
    throw usageError("backend.service_image_digest must be an immutable image digest.", {
      field: "backend.service_image_digest",
    });
  }
  return deepFreeze({
    kind: value.kind,
    runtime_identity: value.runtime_identity,
    image_digest: value.image_digest,
    ...(value.service_image_digest === undefined ? {} : {
      service_image_digest: value.service_image_digest,
    }),
  });
}

function validatePlatform(value, backendKind) {
  const fields = ["host", "supported_hosts"];
  assertRequiredFields(value, fields, "HermeticBoundary platform");
  assertExactFields(value, fields, "HermeticBoundary platform");
  assertEnum(value.host, "platform.host", HERMETIC_SUPPORTED_HOSTS);
  if (!Array.isArray(value.supported_hosts) || value.supported_hosts.length === 0) {
    throw usageError("platform.supported_hosts must be a non-empty array.");
  }
  let previous = null;
  for (const host of value.supported_hosts) {
    assertEnum(host, "platform.supported_hosts", HERMETIC_SUPPORTED_HOSTS);
    if (previous !== null && host <= previous) {
      throw usageError("platform.supported_hosts must be unique and code-unit sorted.");
    }
    previous = host;
  }
  if (!value.supported_hosts.includes(value.host)) {
    throw usageError("platform.host must be included in platform.supported_hosts.");
  }
  if (backendKind === "bubblewrap" && (
    value.host !== "linux" ||
    value.supported_hosts.length !== 1 ||
    value.supported_hosts[0] !== "linux"
  )) {
    throw usageError("bubblewrap boundaries support only a Linux host.");
  }
  return deepFreeze({
    host: value.host,
    supported_hosts: [...value.supported_hosts],
  });
}

function validateFixedPolicy(value, fields, expected, label) {
  assertRequiredFields(value, fields, label);
  assertExactFields(value, fields, label);
  for (const field of fields) {
    if (value[field] !== expected[field]) {
      throw usageError(`${label}.${field} contains unsupported value.`, { field });
    }
  }
  return deepFreeze({ ...expected });
}

function validateNetwork(value, backend) {
  const fields = ["mode", "ambient_egress"];
  assertRequiredFields(value, fields, "HermeticBoundary network");
  assertExactFields(value, fields, "HermeticBoundary network");
  assertEnum(value.mode, "network.mode", ["none", "isolated-service"]);
  if (value.ambient_egress !== "denied") {
    throw usageError("network.ambient_egress must be 'denied'.");
  }
  if (backend.kind === "bubblewrap" && value.mode !== "none") {
    throw usageError("bubblewrap boundaries do not support service networking.");
  }
  if (
    backend.kind === "rootless-oci" &&
    value.mode === "isolated-service" &&
    backend.service_image_digest === undefined
  ) {
    throw usageError(
      "isolated-service boundaries require an immutable OCI service image digest.",
    );
  }
  if (
    backend.kind === "rootless-oci" &&
    value.mode === "none" &&
    backend.service_image_digest !== undefined
  ) {
    throw usageError(
      "network-none boundaries must not declare an OCI service image digest.",
    );
  }
  return deepFreeze({ mode: value.mode, ambient_egress: "denied" });
}

export function validateHermeticBoundary(value, options = {}) {
  validateContractBase(value, BOUNDARY_FIELDS, "HermeticBoundary", options);
  assertExactFields(value, BOUNDARY_FIELDS, "HermeticBoundary");
  if (value.mode !== "hermetic") {
    throw usageError("HermeticBoundary mode must be 'hermetic'.");
  }
  const backend = validateBackend(value.backend);
  const platform = validatePlatform(value.platform, backend.kind);
  const filesystem = validateFixedPolicy(
    value.filesystem,
    ["workspace", "root", "host_home", "runtime_socket"],
    {
      workspace: "read-write",
      root: "read-only",
      host_home: "denied",
      runtime_socket: "denied",
    },
    "HermeticBoundary filesystem",
  );
  const network = validateNetwork(value.network, backend);
  const toolchain = validateFixedPolicy(
    value.toolchain,
    ["downloads", "mutable_cache"],
    { downloads: "denied", mutable_cache: "denied" },
    "HermeticBoundary toolchain",
  );
  const cleanup = validateFixedPolicy(
    value.cleanup,
    ["owner", "residue"],
    { owner: "backend", residue: "denied" },
    "HermeticBoundary cleanup",
  );
  if (
    !Array.isArray(value.refusal_reason_codes) ||
    value.refusal_reason_codes.length !== HERMETIC_REFUSAL_REASON_CODES.length ||
    value.refusal_reason_codes.some(
      (code, index) => code !== HERMETIC_REFUSAL_REASON_CODES[index],
    )
  ) {
    throw usageError("refusal_reason_codes must match the frozen refusal schema.");
  }
  return deepFreeze({
    schema_version: { major: 1 },
    mode: "hermetic",
    backend,
    platform,
    filesystem,
    network,
    toolchain,
    cleanup,
    refusal_reason_codes: [...HERMETIC_REFUSAL_REASON_CODES],
  });
}

export function validateHermeticBoundaryRefusal(value, options = {}) {
  validateContractBase(value, REFUSAL_FIELDS, "HermeticBoundaryRefusal", options);
  assertExactFields(value, REFUSAL_FIELDS, "HermeticBoundaryRefusal");
  if (value.status !== "refused") {
    throw usageError("HermeticBoundaryRefusal status must be 'refused'.");
  }
  assertEnum(value.code, "code", HERMETIC_REFUSAL_REASON_CODES);
  if (value.backend_kind !== null) {
    assertEnum(value.backend_kind, "backend_kind", HERMETIC_BACKEND_KINDS);
  }
  assertEnum(value.host_platform, "host_platform", HERMETIC_REFUSAL_HOSTS);
  assertString(value.message, "message");
  if (value.message.length > 512 || /[\0\r\n]/u.test(value.message)) {
    throw usageError("message must be a bounded single-line string.");
  }
  return deepFreeze(structuredClone(value));
}
