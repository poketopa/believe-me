import { usageError } from "../contracts/errors.js";

function normalizeForCanonicalJson(value, path) {
  if (value === undefined) {
    throw usageError("Canonical JSON cannot encode undefined.", { path });
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw usageError("Canonical JSON cannot encode non-finite numbers.", {
      path,
    });
  }

  if (typeof value === "bigint") {
    throw usageError("Canonical JSON cannot encode bigint values.", { path });
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw usageError(`Canonical JSON cannot encode ${typeof value} values.`, {
      path,
    });
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeForCanonicalJson(item, `${path}[${index}]`),
    );
  }

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = normalizeForCanonicalJson(
      value[key],
      path === "$" ? `$.${key}` : `${path}.${key}`,
    );
  }

  return sorted;
}

export function canonicalJSONString(value) {
  return JSON.stringify(normalizeForCanonicalJson(value, "$"));
}

export function canonicalJSONLine(value) {
  return `${canonicalJSONString(value)}\n`;
}

export function canonicalJSONBytes(value) {
  return Buffer.from(canonicalJSONString(value), "utf8");
}

export function canonicalJSONLineBytes(value) {
  return Buffer.from(canonicalJSONLine(value), "utf8");
}
