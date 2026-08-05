import { HarnessContractError } from "../contracts/errors.js";
import { canonicalJSONLine } from "../core/canonical-json.js";

const defaultInfraMessage = "Unexpected harness error.";
const schemaVersion = Object.freeze({ major: 1 });
const exitCodesByErrorCode = Object.freeze({
  usage_error: 2,
  persisted_schema_unsupported: 3,
  safety_refusal: 3,
  not_found: 4,
  verification_failed: 5,
  infra_error: 10,
});

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function sanitizeCanonicalValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return undefined;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCanonicalValue(item))
      .filter((item) => item !== undefined);
  }

  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    const sanitizedChild = sanitizeCanonicalValue(child);
    if (sanitizedChild !== undefined) {
      sanitized[key] = sanitizedChild;
    }
  }
  return sanitized;
}

function isHarnessLikeError(error) {
  return (
    (error instanceof HarnessContractError ||
      (error !== null &&
      typeof error === "object" &&
      typeof error.code === "string" &&
      typeof error.message === "string" &&
      Number.isInteger(error.exitCode))) &&
    Object.hasOwn(exitCodesByErrorCode, error.code) &&
    error.exitCode === exitCodesByErrorCode[error.code]
  );
}

function normalizeCommand(command) {
  return typeof command === "string" && command !== "" ? command : "unknown";
}

function toErrorPayload(error) {
  if (!isHarnessLikeError(error)) {
    return {
      exitCode: 10,
      error: {
        code: "infra_error",
        details: {},
        message: defaultInfraMessage,
      },
    };
  }

  const exitCode = error.exitCode;
  const details = isPlainObject(error.details)
    ? sanitizeCanonicalValue(error.details)
    : {};

  return {
    exitCode,
    error: {
      code: error.code,
      details,
      message: error.message,
    },
  };
}

export function formatJsonlSuccess(command, data = {}) {
  return {
    exitCode: 0,
    line: canonicalJSONLine({
      schema_version: schemaVersion,
      command: normalizeCommand(command),
      status: "ok",
      data: sanitizeCanonicalValue(data) ?? {},
    }),
  };
}

export function formatJsonlError(command, error) {
  const formatted = toErrorPayload(error);
  return {
    exitCode: formatted.exitCode,
    line: canonicalJSONLine({
      schema_version: schemaVersion,
      command: normalizeCommand(command),
      status: "error",
      error: formatted.error,
    }),
  };
}
