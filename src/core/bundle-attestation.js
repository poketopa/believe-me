import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { resolve } from "node:path";
import {
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
} from "../contracts/common.js";
import { safetyRefusal, verificationFailed } from "../contracts/errors.js";
import { canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import {
  PORTABLE_EVIDENCE_MAX_BYTES,
  verifyPortableEvidenceBytes,
} from "./portable-evidence.js";
import {
  readBoundedRegularFileNoFollow,
  writeAtomicArtifactNoOverwrite,
} from "./safe-artifact.js";

export const BUNDLE_ATTESTATION_KIND = "believeme.bundle-attestation";
export const BUNDLE_ATTESTATION_ALGORITHM = "ed25519";
export const BUNDLE_ATTESTATION_MAX_BYTES = 16 * 1024;
export const BUNDLE_ATTESTATION_CONTEXT =
  "believeme.portable-evidence.attestation.ed25519.v1\0";
export const BUNDLE_ATTESTATION_FIELDS = Object.freeze([
  "schema_version",
  "attestation_kind",
  "signature_algorithm",
  "bundle_sha256",
  "signer_public_key_sha256",
  "signature_base64",
]);

const ATTESTATION_MESSAGES = Object.freeze({
  bytesMalformed: "Bundle attestation bytes are malformed.",
  exceedsLimit: "Bundle attestation exceeds the 16 KiB limit.",
  parentMissing: "Bundle attestation output parent does not exist.",
  parentRealDirectory:
    "Bundle attestation output parent must be a real directory path.",
  noFollowDirectoryUnsupported:
    "Bundle attestation export requires no-follow directory support.",
  outputExists: "Bundle attestation output path already exists.",
  parentIdentityChanged: "Bundle attestation output parent identity changed.",
  missing: "Bundle attestation does not exist.",
  regularFile: "Bundle attestation must be a regular file.",
  noFollowFileUnsupported:
    "Bundle attestation verification requires no-follow file support.",
  identityChanged: "Bundle attestation identity changed.",
});

const BUNDLE_MESSAGES = Object.freeze({
  missing: "Portable evidence bundle does not exist.",
  regularFile: "Portable evidence bundle must be a regular file.",
  exceedsLimit: "Portable evidence bundle exceeds the 64 MiB limit.",
  noFollowFileUnsupported:
    "Portable evidence verification requires no-follow file support.",
  identityChanged: "Portable evidence bundle identity changed.",
});

const PRIVATE_KEY_MESSAGES = Object.freeze({
  missing: "Bundle attestation private key does not exist.",
  regularFile: "Bundle attestation private key must be a regular file.",
  exceedsLimit: "Bundle attestation private key exceeds the 16 KiB limit.",
  noFollowFileUnsupported:
    "Bundle attestation private key read requires no-follow file support.",
  identityChanged: "Bundle attestation private key identity changed.",
});

const PUBLIC_KEY_MESSAGES = Object.freeze({
  missing: "Bundle attestation public key does not exist.",
  regularFile: "Bundle attestation public key must be a regular file.",
  exceedsLimit: "Bundle attestation public key exceeds the 16 KiB limit.",
  noFollowFileUnsupported:
    "Bundle attestation public key read requires no-follow file support.",
  identityChanged: "Bundle attestation public key identity changed.",
});

const contextBytes = Buffer.from(BUNDLE_ATTESTATION_CONTEXT, "ascii");
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function assertExactFields(value, fields, label) {
  assertObject(value, label);
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw safetyRefusal(`${label} is missing required field '${field}'.`, {
        field,
      });
    }
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw safetyRefusal(`${label} contains unsupported field '${field}'.`, {
        field,
      });
    }
  }
}

function validateSchemaVersion(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    value.major !== 1
  ) {
    throw safetyRefusal(`${label} schema is unsupported.`);
  }
}

function validateSignatureBase64(value) {
  assertString(value, "signature_base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw safetyRefusal("Bundle attestation signature must be canonical base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== value) {
    throw safetyRefusal(
      "Bundle attestation signature must encode exactly 64 bytes.",
    );
  }
  return decoded;
}

function translateAttestationContractError(operation) {
  try {
    return operation();
  } catch (error) {
    if (
      error?.code === "safety_refusal" ||
      error?.code === "verification_failed"
    ) {
      throw error;
    }
    if (error?.code !== "usage_error") {
      throw error;
    }
    throw safetyRefusal("Bundle attestation is malformed.", {
      cause_code: error.code,
    });
  }
}

function attestationPreimage(bundleBytes) {
  return Buffer.concat([contextBytes, bundleBytes]);
}

function keyFingerprint(publicKey) {
  return sha256Hex(publicKey.export({ type: "spki", format: "der" }));
}

function assertPemEnvelope(bytes, type, message) {
  let text;
  try {
    text = fatalUtf8Decoder.decode(bytes);
  } catch {
    throw safetyRefusal(message);
  }
  const label = type === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
  const pattern = new RegExp(
    `^-----BEGIN ${label}-----\\r?\\n[\\s\\S]+\\r?\\n-----END ${label}-----\\r?\\n?$`,
  );
  if (!pattern.test(text)) {
    throw safetyRefusal(message);
  }
}

function createEd25519PrivateKey(bytes) {
  const message = "Bundle attestation private key must be PKCS8 PEM Ed25519.";
  assertPemEnvelope(bytes, "private", message);
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: bytes, format: "pem", type: "pkcs8" });
  } catch {
    throw safetyRefusal(message);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw safetyRefusal(message);
  }
  return privateKey;
}

function createEd25519PublicKey(bytes) {
  const message = "Bundle attestation public key must be SPKI PEM Ed25519.";
  assertPemEnvelope(bytes, "public", message);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: bytes, format: "pem", type: "spki" });
  } catch {
    throw safetyRefusal(message);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw safetyRefusal(message);
  }
  return publicKey;
}

function assertPrivateKeyMode(stats, path) {
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw safetyRefusal(
      "Bundle attestation private key must not grant group or other permissions.",
      { path },
    );
  }
}

async function readBundleBytes(bundlePath, cwd, options = {}) {
  const artifact = await readBoundedRegularFileNoFollow(bundlePath, {
    ...options,
    cwd,
    maxBytes: PORTABLE_EVIDENCE_MAX_BYTES,
    messages: BUNDLE_MESSAGES,
  });
  const portable = verifyPortableEvidenceBytes(artifact.bytes);
  return { ...artifact, portable };
}

async function readPrivateKey(privateKeyPath, cwd) {
  const { bytes } = await readBoundedRegularFileNoFollow(privateKeyPath, {
    cwd,
    maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
    messages: PRIVATE_KEY_MESSAGES,
    validateStats: assertPrivateKeyMode,
  });
  return createEd25519PrivateKey(bytes);
}

async function readPublicKey(publicKeyPath, cwd) {
  const { bytes } = await readBoundedRegularFileNoFollow(publicKeyPath, {
    cwd,
    maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
    messages: PUBLIC_KEY_MESSAGES,
  });
  return createEd25519PublicKey(bytes);
}

function buildAttestationValue({
  bundleSha256,
  signerPublicKeySha256,
  signature,
}) {
  return deepFreeze({
    schema_version: { major: 1 },
    attestation_kind: BUNDLE_ATTESTATION_KIND,
    signature_algorithm: BUNDLE_ATTESTATION_ALGORITHM,
    bundle_sha256: bundleSha256,
    signer_public_key_sha256: signerPublicKeySha256,
    signature_base64: signature.toString("base64"),
  });
}

function verifyBundleAttestationBytes({
  bundleBytes,
  attestationBytes,
  publicKey,
}) {
  const portable = verifyPortableEvidenceBytes(bundleBytes);
  if (!Buffer.isBuffer(attestationBytes) || attestationBytes.byteLength === 0) {
    throw safetyRefusal("Bundle attestation must not be empty.");
  }
  if (attestationBytes.byteLength > BUNDLE_ATTESTATION_MAX_BYTES) {
    throw safetyRefusal("Bundle attestation exceeds the 16 KiB limit.");
  }

  let line;
  try {
    line = fatalUtf8Decoder.decode(attestationBytes);
  } catch {
    throw safetyRefusal("Bundle attestation must be valid UTF-8.");
  }
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal("Bundle attestation must be exactly one JSON line.");
  }

  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal("Bundle attestation JSON is malformed.");
  }
  if (!canonicalJSONLineBytes(value).equals(attestationBytes)) {
    throw safetyRefusal("Bundle attestation is not canonical JSONL.");
  }
  return translateAttestationContractError(() => {
    assertExactFields(value, BUNDLE_ATTESTATION_FIELDS, "Bundle attestation");
    validateSchemaVersion(value.schema_version, "Bundle attestation");
    if (value.attestation_kind !== BUNDLE_ATTESTATION_KIND) {
      throw safetyRefusal("Bundle attestation kind is unsupported.");
    }
    if (value.signature_algorithm !== BUNDLE_ATTESTATION_ALGORITHM) {
      throw safetyRefusal(
        "Bundle attestation signature algorithm is unsupported.",
      );
    }
    assertSha256Hex(value.bundle_sha256, "bundle_sha256");
    assertSha256Hex(
      value.signer_public_key_sha256,
      "signer_public_key_sha256",
    );
    const bundleSha256 = sha256Hex(bundleBytes);
    if (value.bundle_sha256 !== bundleSha256) {
      throw verificationFailed("Bundle attestation bundle digest mismatch.", {
        expected_sha256: value.bundle_sha256,
        actual_sha256: bundleSha256,
      });
    }
    const signerPublicKeySha256 = keyFingerprint(publicKey);
    if (value.signer_public_key_sha256 !== signerPublicKeySha256) {
      throw verificationFailed("Bundle attestation signer key mismatch.", {
        expected_sha256: value.signer_public_key_sha256,
        actual_sha256: signerPublicKeySha256,
      });
    }
    const signatureBytes = validateSignatureBase64(value.signature_base64);
    const ok = verify(
      null,
      attestationPreimage(bundleBytes),
      publicKey,
      signatureBytes,
    );
    if (!ok) {
      throw verificationFailed(
        "Bundle attestation signature verification failed.",
      );
    }

    return deepFreeze({
      verification_status: "bundle_attestation_verified",
      attestation_kind: BUNDLE_ATTESTATION_KIND,
      signature_algorithm: BUNDLE_ATTESTATION_ALGORITHM,
      bundle_sha256: bundleSha256,
      bundle_bytes: bundleBytes.byteLength,
      attestation_sha256: sha256Hex(attestationBytes),
      attestation_bytes: attestationBytes.byteLength,
      signer_public_key_sha256: signerPublicKeySha256,
      portable_evidence: portable,
      trust: {
        caller_trusted_key: true,
        freshness: false,
        transparency: false,
        revocation: false,
        apply_authority: false,
      },
    });
  });
}

export async function createBundleAttestation({
  bundlePath,
  privateKeyPath,
  outputPath,
  cwd,
} = {}) {
  assertString(bundlePath, "bundlePath");
  assertString(privateKeyPath, "privateKeyPath");
  assertString(outputPath, "outputPath");
  const resolvedCwd = resolve(cwd ?? process.cwd());
  const [{ bytes: bundleBytes, portable }, privateKey] = await Promise.all([
    readBundleBytes(bundlePath, resolvedCwd),
    readPrivateKey(privateKeyPath, resolvedCwd),
  ]);
  const publicKey = createPublicKey(privateKey);
  const signature = sign(null, attestationPreimage(bundleBytes), privateKey);
  const signerPublicKeySha256 = keyFingerprint(publicKey);
  const value = buildAttestationValue({
    bundleSha256: portable.bundle_sha256,
    signerPublicKeySha256,
    signature,
  });
  const bytes = canonicalJSONLineBytes(value);
  const published = await writeAtomicArtifactNoOverwrite(outputPath, bytes, {
    cwd: resolvedCwd,
    maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
    temporaryPrefix: "believeme-attestation",
    messages: ATTESTATION_MESSAGES,
  });
  return deepFreeze({
    creation_status: "bundle_attestation_created",
    output_path: published.output_path,
    attestation_kind: BUNDLE_ATTESTATION_KIND,
    signature_algorithm: BUNDLE_ATTESTATION_ALGORITHM,
    bundle_sha256: portable.bundle_sha256,
    bundle_bytes: bundleBytes.byteLength,
    attestation_sha256: published.sha256,
    attestation_bytes: published.bytes,
    signer_public_key_sha256: signerPublicKeySha256,
    portable_evidence: portable,
    trust: {
      caller_trusted_key: true,
      freshness: false,
      transparency: false,
      revocation: false,
      apply_authority: false,
    },
  });
}

export async function verifyBundleAttestation({
  bundlePath,
  attestationPath,
  publicKeyPath,
  cwd,
} = {}) {
  assertString(bundlePath, "bundlePath");
  assertString(attestationPath, "attestationPath");
  assertString(publicKeyPath, "publicKeyPath");
  const resolvedCwd = resolve(cwd ?? process.cwd());
  const { bytes: bundleBytes } = await readBundleBytes(
    bundlePath,
    resolvedCwd,
  );
  const [{ bytes: attestationBytes }, publicKey] = await Promise.all([
    readBoundedRegularFileNoFollow(attestationPath, {
      cwd: resolvedCwd,
      maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
      messages: ATTESTATION_MESSAGES,
    }),
    readPublicKey(publicKeyPath, resolvedCwd),
  ]);
  return verifyBundleAttestationBytes({
    bundleBytes,
    attestationBytes,
    publicKey,
  });
}
