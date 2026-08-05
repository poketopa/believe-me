import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_SPRING_VERIFIER_SPEC,
  validateVerifierSpec,
  verifierSpecFromManifest,
} from "../../../src/contracts/verifier.js";

const schema_version = { major: 1 };

function commandSpec(overrides = {}) {
  return {
    schema_version,
    adapter_id: "command-verifier",
    command: "node",
    args: ["--test"],
    timeout_ms: 30_000,
    max_output_bytes: 1_048_576,
    ...overrides,
  };
}

test("verifier specs validate, freeze, and preserve exact argv", () => {
  const value = validateVerifierSpec(commandSpec({
    command: "./tools/verify",
    args: ["--mode", "strict", ""],
  }));

  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.args), true);
  assert.deepEqual(value.args, ["--mode", "strict", ""]);
  assert.equal(
    validateVerifierSpec(LEGACY_SPRING_VERIFIER_SPEC).adapter_id,
    "spring-verifier",
  );
});

test("command verifier specs reject unsafe paths and unbounded process inputs", () => {
  for (const command of ["/bin/node", "../node", "tools/node", "./tools/../node", "node --test"]){
    assert.throws(
      () => validateVerifierSpec(commandSpec({ command })),
      /verifier\.command/u,
    );
  }
  assert.throws(
    () => validateVerifierSpec(commandSpec({ args: ["bad\0arg"] })),
    /without NUL bytes/u,
  );
  assert.throws(
    () => validateVerifierSpec(commandSpec({ timeout_ms: 0 })),
    /positive safe integer/u,
  );
  assert.throws(
    () => validateVerifierSpec(commandSpec({ max_output_bytes: 16 * 1024 * 1024 + 1 })),
    /positive safe integer/u,
  );
  assert.throws(
    () => validateVerifierSpec({ schema_version, adapter_id: "plugin" }),
    /unsupported value 'plugin'/u,
  );
});

test("missing v1 manifest verifier resolves to the frozen Spring compatibility spec", () => {
  const resolved = verifierSpecFromManifest({ schema_version, manifest_id: "legacy" });
  assert.equal(resolved, LEGACY_SPRING_VERIFIER_SPEC);
  assert.equal(Object.isFrozen(resolved), true);

  const explicit = verifierSpecFromManifest({
    verifier: commandSpec(),
  });
  assert.equal(explicit.adapter_id, "command-verifier");
});
