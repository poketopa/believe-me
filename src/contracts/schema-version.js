import { persistedSchemaUnsupported, usageError } from "./errors.js";

export const SUPPORTED_SCHEMA_MAJOR = 1;

export function schemaVersion(major = SUPPORTED_SCHEMA_MAJOR) {
  return Object.freeze({ major });
}

export function getSchemaMajor(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isInteger(value.major)
  ) {
    return value.major;
  }

  return undefined;
}

export function assertSupportedSchemaVersion(value, { persisted = false } = {}) {
  const major = getSchemaMajor(value);

  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    const details = {
      expected_major: SUPPORTED_SCHEMA_MAJOR,
      received_major: major ?? null,
    };
    if (persisted) {
      throw persistedSchemaUnsupported(
        "Persisted schema major is unsupported.",
        details,
      );
    }

    throw usageError("Schema major is unsupported.", details);
  }
}
