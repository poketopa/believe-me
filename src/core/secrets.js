const highConfidenceSecretPatterns = Object.freeze([
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)\b\s*(?:=|:)\s*["'][^"'\r\n]{8,}["']/iu,
  /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/iu,
]);

function validUtf8Text(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), "utf8");
  if (buffer.includes(0)) {
    return null;
  }
  const text = buffer.toString("utf8");
  return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}

export function containsLikelyCredential(value) {
  const text = validUtf8Text(value);
  return text !== null && highConfidenceSecretPatterns.some(
    (pattern) => pattern.test(text),
  );
}
