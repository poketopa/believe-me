import { createHash } from "node:crypto";
import { canonicalJSONBytes, canonicalJSONLineBytes } from "./canonical-json.js";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256CanonicalJSON(value) {
  return sha256Hex(canonicalJSONBytes(value));
}

export function sha256CanonicalJSONLine(value) {
  return sha256Hex(canonicalJSONLineBytes(value));
}
