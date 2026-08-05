import {
  assertObject,
  assertString,
  deepFreeze,
} from "./common.js";
import { usageError } from "./errors.js";
import { assertSupportedSchemaVersion } from "./schema-version.js";

export const VERIFIER_ADAPTER_IDS = Object.freeze([
  "spring-verifier",
  "command-verifier",
]);

export const COMMAND_VERIFIER_LIMITS = Object.freeze({
  max_args: 128,
  max_arg_bytes: 8_192,
  max_timeout_ms: 3_600_000,
  max_output_bytes: 16 * 1024 * 1024,
});

export const LEGACY_SPRING_VERIFIER_SPEC = deepFreeze({
  schema_version: { major: 1 },
  adapter_id: "spring-verifier",
});

function assertPositiveBoundedInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw usageError(`${field} must be a positive safe integer no greater than ${maximum}.`, {
      field,
      maximum,
    });
  }
}

function assertPortableCommand(value) {
  assertString(value, "verifier.command");
  if (
    value.length > 512 ||
    /[\0\r\n\\]/u.test(value) ||
    value.endsWith("/")
  ) {
    throw usageError("verifier.command must be a bounded portable executable reference.", {
      field: "verifier.command",
    });
  }
  if (!value.includes("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) {
      throw usageError("verifier.command executable names contain unsupported characters.", {
        field: "verifier.command",
      });
    }
    return;
  }
  if (!value.startsWith("./")) {
    throw usageError("verifier.command paths must be project-relative and start with './'.", {
      field: "verifier.command",
    });
  }
  const segments = value.slice(2).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw usageError("verifier.command must not contain empty or dot path segments.", {
      field: "verifier.command",
    });
  }
}

function assertVerifierArgs(value) {
  if (!Array.isArray(value) || value.length > COMMAND_VERIFIER_LIMITS.max_args) {
    throw usageError(
      `verifier.args must be an array with at most ${COMMAND_VERIFIER_LIMITS.max_args} entries.`,
      { field: "verifier.args" },
    );
  }
  for (const argument of value) {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument, "utf8") > COMMAND_VERIFIER_LIMITS.max_arg_bytes ||
      argument.includes("\0")
    ) {
      throw usageError("verifier.args entries must be bounded strings without NUL bytes.", {
        field: "verifier.args",
      });
    }
  }
}

export function validateVerifierSpec(value, options = {}) {
  assertObject(value, "verifier");
  assertSupportedSchemaVersion(value.schema_version, options);
  assertString(value.adapter_id, "verifier.adapter_id");
  if (!VERIFIER_ADAPTER_IDS.includes(value.adapter_id)) {
    throw usageError(`verifier.adapter_id contains unsupported value '${value.adapter_id}'.`, {
      field: "verifier.adapter_id",
      allowed_values: VERIFIER_ADAPTER_IDS,
    });
  }

  if (value.adapter_id === "command-verifier") {
    for (const field of ["command", "args", "timeout_ms", "max_output_bytes"]) {
      if (!Object.hasOwn(value, field)) {
        throw usageError(`command verifier is missing required field '${field}'.`, {
          field,
        });
      }
    }
    assertPortableCommand(value.command);
    assertVerifierArgs(value.args);
    assertPositiveBoundedInteger(
      value.timeout_ms,
      "verifier.timeout_ms",
      COMMAND_VERIFIER_LIMITS.max_timeout_ms,
    );
    assertPositiveBoundedInteger(
      value.max_output_bytes,
      "verifier.max_output_bytes",
      COMMAND_VERIFIER_LIMITS.max_output_bytes,
    );
  }

  return deepFreeze(structuredClone(value));
}

export function verifierSpecFromManifest(manifest, options = {}) {
  assertObject(manifest, "SkillManifest");
  if (!Object.hasOwn(manifest, "verifier")) {
    return LEGACY_SPRING_VERIFIER_SPEC;
  }
  return validateVerifierSpec(manifest.verifier, options);
}
