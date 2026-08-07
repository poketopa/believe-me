import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJSONLineBytes } from "../../../src/core/canonical-json.js";
import { sha256Hex } from "../../../src/core/hash.js";
import {
  buildPortableEvidenceBundle,
  readPortableEvidenceBundle,
  writePortableEvidenceBundle,
} from "../../../src/core/portable-evidence.js";
import {
  BUNDLE_ATTESTATION_ALGORITHM,
  BUNDLE_ATTESTATION_CONTEXT,
  BUNDLE_ATTESTATION_FIELDS,
  BUNDLE_ATTESTATION_KIND,
  BUNDLE_ATTESTATION_MAX_BYTES,
  createBundleAttestation,
  verifyBundleAttestation,
} from "../../../src/core/bundle-attestation.js";
import { writeAtomicArtifactNoOverwrite } from "../../../src/core/safe-artifact.js";

const stateSha256 = "a".repeat(64);

function portableFixture(overrides = {}) {
  const content = Buffer.from("attested candidate\n", "utf8");
  const verification = {
    schema_version: { major: 1 },
    adapter_id: "manifest-command",
    status: "passed",
  };
  const result = {
    schema_version: { major: 1 },
    run_id: "run-attested",
    executor_kind: "deterministic",
    status: "completed",
    changes: [{
      path: "src/attested.txt",
      content_base64: content.toString("base64"),
      sha256: sha256Hex(content),
    }],
  };
  const receipt = {
    schema_version: { major: 1 },
    run_id: "run-attested",
    manifest_sha256: "b".repeat(64),
    workflow_plan_sha256: "c".repeat(64),
    source_snapshot_sha256: "d".repeat(64),
    verification_sha256: sha256Hex(canonicalJSONLineBytes(verification)),
    result_sha256: sha256Hex(canonicalJSONLineBytes(result)),
    approval_method: "receipt_sha256",
    issued_at: "2026-08-05T23:00:00.000Z",
  };
  const receiptSha256 = sha256Hex(canonicalJSONLineBytes(receipt));
  const state = {
    run_id: "run-attested",
    lifecycle_state: "receipted",
    manifest_sha256: receipt.manifest_sha256,
    workflow_plan_sha256: receipt.workflow_plan_sha256,
    source_snapshot_sha256: receipt.source_snapshot_sha256,
    executor_kind: "deterministic",
    receipt_sha256: receiptSha256,
  };
  return {
    state: { ...state, ...overrides.state },
    stateSha256: overrides.stateSha256 ?? stateSha256,
    evidence: {
      receipt_sha256: receiptSha256,
      receipt,
      verification,
      result,
      ...overrides.evidence,
    },
  };
}

async function writeKeys(parent, prefix = "signer") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(parent, `${prefix}.private.pem`);
  const publicKeyPath = join(parent, `${prefix}.public.pem`);
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await chmod(privateKeyPath, 0o600);
  await writeFile(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  await chmod(publicKeyPath, 0o600);
  return { privateKeyPath, publicKeyPath };
}

async function writeBundle(parent, name = "bundle.jsonl") {
  const bundle = buildPortableEvidenceBundle(portableFixture());
  const bundlePath = join(parent, name);
  await writePortableEvidenceBundle(bundlePath, bundle.bytes);
  return { bundle, bundlePath };
}

function rebuildAttestation(value, changes) {
  return canonicalJSONLineBytes({ ...value, ...changes });
}

function withoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

test("bundle attestation contract field table is explicit", () => {
  assert.deepEqual(BUNDLE_ATTESTATION_FIELDS, [
    "schema_version",
    "attestation_kind",
    "signature_algorithm",
    "bundle_sha256",
    "signer_public_key_sha256",
    "signature_base64",
  ]);
  assert.equal(BUNDLE_ATTESTATION_KIND, "believeme.bundle-attestation");
  assert.equal(BUNDLE_ATTESTATION_ALGORITHM, "ed25519");
  assert.equal(
    BUNDLE_ATTESTATION_CONTEXT,
    "believeme.portable-evidence.attestation.ed25519.v1\0",
  );
  assert.equal(BUNDLE_ATTESTATION_MAX_BYTES, 16 * 1024);
});

test("bundle attestations are deterministic, canonical, and verify to bounded trust summary", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const { bundle, bundlePath } = await writeBundle(parent);
  const { privateKeyPath, publicKeyPath } = await writeKeys(parent);
  const firstPath = join(parent, "first.attestation.jsonl");
  const secondPath = join(parent, "second.attestation.jsonl");

  const first = await createBundleAttestation({
    bundlePath,
    privateKeyPath,
    outputPath: firstPath,
  });
  const second = await createBundleAttestation({
    bundlePath,
    privateKeyPath,
    outputPath: secondPath,
  });

  assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
  assert.equal(first.attestation_sha256, second.attestation_sha256);
  assert.equal((await lstat(firstPath)).mode & 0o777, 0o600);
  assert.equal(first.bundle_sha256, bundle.bundle_sha256);
  assert.equal(first.trust.caller_trusted_key, true);
  assert.equal(first.trust.freshness, false);
  assert.equal(first.trust.transparency, false);
  assert.equal(first.trust.revocation, false);
  assert.equal(first.trust.apply_authority, false);

  const value = JSON.parse((await readFile(firstPath, "utf8")).slice(0, -1));
  assert.deepEqual(Object.keys(value).sort(), [...BUNDLE_ATTESTATION_FIELDS].sort());
  assert.equal(value.signature_base64, Buffer.from(value.signature_base64, "base64").toString("base64"));
  assert.equal(Buffer.from(value.signature_base64, "base64").byteLength, 64);

  const verified = await verifyBundleAttestation({
    bundlePath,
    attestationPath: firstPath,
    publicKeyPath,
  });
  assert.equal(verified.verification_status, "bundle_attestation_verified");
  assert.equal(verified.bundle_sha256, bundle.bundle_sha256);
  assert.equal(verified.attestation_sha256, first.attestation_sha256);
  assert.equal(verified.portable_evidence.run_id, "run-attested");
  assert.deepEqual(verified.trust, first.trust);
  assert.equal(JSON.stringify(verified).includes("content_base64"), false);

  assert.equal((await readPortableEvidenceBundle(bundlePath)).run_id, "run-attested");
});

test("bundle attestation verification rejects malformed, missing, and extra fields", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const { bundlePath } = await writeBundle(parent);
  const { privateKeyPath, publicKeyPath } = await writeKeys(parent);
  const attestationPath = join(parent, "attestation.jsonl");
  await createBundleAttestation({ bundlePath, privateKeyPath, outputPath: attestationPath });
  const value = JSON.parse((await readFile(attestationPath, "utf8")).slice(0, -1));

  const cases = [
    Buffer.alloc(0),
    Buffer.from("{}\n", "utf8"),
    Buffer.from("{}", "utf8"),
    Buffer.from("{}\ntrailing", "utf8"),
    Buffer.from("{]\n", "utf8"),
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    rebuildAttestation(value, { schema_version: { major: 2 } }),
    rebuildAttestation(value, { attestation_kind: "wrong" }),
    rebuildAttestation(value, { signature_algorithm: "rsa" }),
    rebuildAttestation(value, { bundle_sha256: "wrong" }),
    rebuildAttestation(value, { signer_public_key_sha256: "wrong" }),
    rebuildAttestation(value, { signature_base64: value.signature_base64.replace(/=+$/u, "") }),
    rebuildAttestation(value, { extra: true }),
  ];
  for (const field of BUNDLE_ATTESTATION_FIELDS) {
    cases.push(canonicalJSONLineBytes(withoutField(value, field)));
  }

  for (let index = 0; index < cases.length; index += 1) {
    const malformedPath = join(parent, `malformed-${index}.jsonl`);
    await writeFile(malformedPath, cases[index], { mode: 0o600 });
    await assert.rejects(
      () => verifyBundleAttestation({
        bundlePath,
        attestationPath: malformedPath,
        publicKeyPath,
      }),
      (error) =>
        error.code === "safety_refusal" || error.code === "verification_failed",
    );
  }
});

test("bundle attestation rejects wrong key, wrong hash, wrong signature, and bundle tamper", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const { bundlePath } = await writeBundle(parent);
  const { privateKeyPath, publicKeyPath } = await writeKeys(parent, "right");
  const { publicKeyPath: wrongPublicKeyPath } = await writeKeys(parent, "wrong");
  const attestationPath = join(parent, "attestation.jsonl");
  await createBundleAttestation({ bundlePath, privateKeyPath, outputPath: attestationPath });
  const value = JSON.parse((await readFile(attestationPath, "utf8")).slice(0, -1));

  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath, publicKeyPath: wrongPublicKeyPath }),
    (error) => error.code === "verification_failed",
  );

  const wrongHashPath = join(parent, "wrong-hash.jsonl");
  await writeFile(wrongHashPath, rebuildAttestation(value, { bundle_sha256: "e".repeat(64) }), { mode: 0o600 });
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath: wrongHashPath, publicKeyPath }),
    (error) => error.code === "verification_failed",
  );

  const wrongSignaturePath = join(parent, "wrong-signature.jsonl");
  const signature = Buffer.from(value.signature_base64, "base64");
  signature[0] ^= 0xff;
  await writeFile(wrongSignaturePath, rebuildAttestation(value, { signature_base64: signature.toString("base64") }), { mode: 0o600 });
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath: wrongSignaturePath, publicKeyPath }),
    (error) => error.code === "verification_failed",
  );

  const tamperedBundlePath = join(parent, "tampered-bundle.jsonl");
  await writeFile(tamperedBundlePath, Buffer.concat([await readFile(bundlePath), Buffer.from("x")]), { mode: 0o600 });
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath: tamperedBundlePath, attestationPath, publicKeyPath }),
    (error) => error.code === "safety_refusal",
  );
});

test("bundle attestation signs exact canonical bundle bytes including the final line feed", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const { bundle, bundlePath } = await writeBundle(parent);
  const { privateKeyPath, publicKeyPath } = await writeKeys(parent);
  const attestationPath = join(parent, "attestation.jsonl");
  await createBundleAttestation({ bundlePath, privateKeyPath, outputPath: attestationPath });

  const noFinalLfPath = join(parent, "no-final-lf.jsonl");
  await writeFile(noFinalLfPath, bundle.bytes.subarray(0, bundle.bytes.length - 1), { mode: 0o600 });
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath: noFinalLfPath, attestationPath, publicKeyPath }),
    (error) => error.code === "safety_refusal",
  );
});

test("bundle attestation validates key type, encoding, mode, size, and symlinks", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const { bundlePath } = await writeBundle(parent);
  const { privateKeyPath, publicKeyPath } = await writeKeys(parent, "ed");
  const attestationPath = join(parent, "attestation.jsonl");

  await chmod(privateKeyPath, 0o644);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath, outputPath: attestationPath }),
    (error) => error.code === "safety_refusal",
  );
  await chmod(privateKeyPath, 0o600);

  const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPrivatePath = join(parent, "rsa-private.pem");
  const rsaPublicPath = join(parent, "rsa-public.pem");
  await writeFile(rsaPrivatePath, rsaPrivateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(rsaPrivatePath, 0o600);
  await writeFile(rsaPublicPath, rsaPublicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  await chmod(rsaPublicPath, 0o600);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath: rsaPrivatePath, outputPath: attestationPath }),
    (error) => error.code === "safety_refusal",
  );

  await createBundleAttestation({ bundlePath, privateKeyPath, outputPath: attestationPath });
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath, publicKeyPath: rsaPublicPath }),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => createBundleAttestation({
      bundlePath,
      privateKeyPath: publicKeyPath,
      outputPath: join(parent, "public-as-private.attestation.jsonl"),
    }),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => verifyBundleAttestation({
      bundlePath,
      attestationPath,
      publicKeyPath: privateKeyPath,
    }),
    (error) => error.code === "safety_refusal",
  );

  const badPrivatePath = join(parent, "bad-private.pem");
  const badPublicPath = join(parent, "bad-public.pem");
  await writeFile(badPrivatePath, "not a pem", { mode: 0o600 });
  await chmod(badPrivatePath, 0o600);
  await writeFile(badPublicPath, "not a pem", { mode: 0o600 });
  await chmod(badPublicPath, 0o600);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath: badPrivatePath, outputPath: join(parent, "bad.attestation.jsonl") }),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath, publicKeyPath: badPublicPath }),
    (error) => error.code === "safety_refusal",
  );

  const oversizedPrivatePath = join(parent, "oversized-private.pem");
  const oversizedPublicPath = join(parent, "oversized-public.pem");
  const handle = await open(oversizedPrivatePath, "wx", 0o600);
  await handle.truncate(BUNDLE_ATTESTATION_MAX_BYTES + 1);
  await handle.close();
  await chmod(oversizedPrivatePath, 0o600);
  await writeFile(oversizedPublicPath, Buffer.alloc(BUNDLE_ATTESTATION_MAX_BYTES + 1), { mode: 0o600 });
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath: oversizedPrivatePath, outputPath: join(parent, "oversized.attestation.jsonl") }),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath, publicKeyPath: oversizedPublicPath }),
    (error) => error.code === "safety_refusal",
  );

  const privateAlias = join(parent, "private-alias.pem");
  const publicAlias = join(parent, "public-alias.pem");
  await symlink(privateKeyPath, privateAlias);
  await symlink(publicKeyPath, publicAlias);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath: privateAlias, outputPath: join(parent, "alias.attestation.jsonl") }),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => verifyBundleAttestation({ bundlePath, attestationPath, publicKeyPath: publicAlias }),
    (error) => error.code === "safety_refusal",
  );
});

test("bundle attestation publication refuses symlinks, overwrite, races, and cleans failure leftovers", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "believeme-outside-")));
  const { bundlePath } = await writeBundle(parent);
  const { privateKeyPath } = await writeKeys(parent);
  const firstPath = join(parent, "first.attestation.jsonl");
  await createBundleAttestation({ bundlePath, privateKeyPath, outputPath: firstPath });
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath, outputPath: firstPath }),
    (error) => error.code === "safety_refusal",
  );

  const outputAlias = join(parent, "output-alias.jsonl");
  await symlink(firstPath, outputAlias);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath, outputPath: outputAlias }),
    (error) => error.code === "safety_refusal",
  );

  const redirected = join(parent, "redirected");
  await symlink(outside, redirected);
  await assert.rejects(
    () => createBundleAttestation({ bundlePath, privateKeyPath, outputPath: join(redirected, "attestation.jsonl") }),
    (error) => error.code === "safety_refusal",
  );

  const racePath = join(parent, "race.attestation.jsonl");
  const winner = Buffer.from("concurrent winner\n", "utf8");
  await assert.rejects(
    () => writeAtomicArtifactNoOverwrite(racePath, Buffer.from("{}\n", "utf8"), {
      maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
      temporaryPrefix: "believeme-attestation",
      messages: {
        bytesMalformed: "Bundle attestation bytes are malformed.",
        exceedsLimit: "Bundle attestation exceeds the 16 KiB limit.",
        parentMissing: "Bundle attestation output parent does not exist.",
        parentRealDirectory: "Bundle attestation output parent must be a real directory path.",
        noFollowDirectoryUnsupported: "Bundle attestation export requires no-follow directory support.",
        outputExists: "Bundle attestation output path already exists.",
        parentIdentityChanged: "Bundle attestation output parent identity changed.",
      },
      async publishLink(source, target) {
        await writeFile(target, winner, { flag: "wx", mode: 0o600 });
        await link(source, target);
      },
    }),
    (error) => error.code === "safety_refusal",
  );
  assert.deepEqual(await readFile(racePath), winner);

  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-attest-swap-")));
  const swapParent = join(root, "parent");
  const moved = join(root, "moved-parent");
  const swapOutside = join(root, "outside");
  await mkdir(swapParent);
  await mkdir(swapOutside);
  await assert.rejects(
    () => writeAtomicArtifactNoOverwrite(join(swapParent, "attestation.jsonl"), Buffer.from("{}\n", "utf8"), {
      maxBytes: BUNDLE_ATTESTATION_MAX_BYTES,
      temporaryPrefix: "believeme-attestation",
      messages: {
        bytesMalformed: "Bundle attestation bytes are malformed.",
        exceedsLimit: "Bundle attestation exceeds the 16 KiB limit.",
        parentMissing: "Bundle attestation output parent does not exist.",
        parentRealDirectory: "Bundle attestation output parent must be a real directory path.",
        noFollowDirectoryUnsupported: "Bundle attestation export requires no-follow directory support.",
        outputExists: "Bundle attestation output path already exists.",
        parentIdentityChanged: "Bundle attestation output parent identity changed.",
      },
      async publishLink() {
        await rename(swapParent, moved);
        await symlink(swapOutside, swapParent);
        throw new Error("injected publication failure");
      },
    }),
    /injected publication failure/,
  );
  assert.deepEqual(await readdir(swapOutside), []);
  assert.deepEqual(await readdir(moved), []);
});
