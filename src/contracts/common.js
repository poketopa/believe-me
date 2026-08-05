import { usageError } from "./errors.js";
import { assertSupportedSchemaVersion } from "./schema-version.js";

export const EXECUTOR_KINDS = Object.freeze(["deterministic", "codex"]);

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

export function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${label} must be an object.`);
  }
}

export function assertRequiredFields(value, fields, label) {
  assertObject(value, label);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw usageError(`${label} is missing required field '${field}'.`, {
        field,
      });
    }
  }
}

export function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`${field} must be a non-empty string.`, { field });
  }
}

export function assertSha256Hex(value, field) {
  assertString(value, field);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw usageError(`${field} must be a lowercase SHA-256 hex digest.`, {
      field,
    });
  }
}

export function assertStringArray(value, field, allowedValues = undefined) {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError(`${field} must be a non-empty array.`, { field });
  }

  const seen = new Set();
  for (const item of value) {
    assertString(item, field);
    if (seen.has(item)) {
      throw usageError(`${field} must not contain duplicates.`, { field });
    }
    seen.add(item);
    if (allowedValues !== undefined && !allowedValues.includes(item)) {
      throw usageError(`${field} contains unsupported value '${item}'.`, {
        field,
        allowed_values: allowedValues,
      });
    }
  }
}

export function assertEnum(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw usageError(`${field} contains unsupported value '${value}'.`, {
      field,
      allowed_values: allowedValues,
    });
  }
}

export function validateContractBase(value, requiredFields, label, options) {
  assertRequiredFields(value, requiredFields, label);
  assertSupportedSchemaVersion(value.schema_version, options);
}
