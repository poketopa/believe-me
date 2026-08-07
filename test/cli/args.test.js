import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../src/cli/args.js";

const sha = "a".repeat(64);

test("parses demo without project or authority inputs", () => {
  assert.deepEqual(parseCliArgs(["demo"]), { command: "demo" });
  assert.throws(() => parseCliArgs(["demo", "extra"]), /positional argument count/);
  assert.throws(() => parseCliArgs(["demo", "--project", "/repo"]), /Unknown flag/);
});

test("parses init with optional project and state directory", () => {
  const parsed = parseCliArgs([
    "init",
    "--project",
    "/repo",
    "--state-dir",
    "/repo/.harness",
  ]);

  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parsed, {
    command: "init",
    project: "/repo",
    stateDir: "/repo/.harness",
  });
});

test("parses run with required executor inputs", () => {
  assert.deepEqual(
    parseCliArgs([
      "run",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--executor",
      "deterministic",
      "--input",
      "input.json",
    ]),
    {
      command: "run",
      project: "/repo",
      skill: "skill.json",
      executor: "deterministic",
      input: "input.json",
    },
  );
});

test("parses run-bound and portable evidence commands", () => {
  assert.deepEqual(parseCliArgs(["status", "run-1"]), {
    command: "status",
    runId: "run-1",
  });
  assert.deepEqual(parseCliArgs(["receipt", "run-1", "--project", "/repo"]), {
    command: "receipt",
    runId: "run-1",
    project: "/repo",
  });
  assert.deepEqual(parseCliArgs(["apply", "run-1", "--approve", sha]), {
    command: "apply",
    runId: "run-1",
    approve: sha,
  });
  assert.deepEqual(parseCliArgs(["review", "run-1"]), {
    command: "review",
    runId: "run-1",
  });
  assert.deepEqual(parseCliArgs(["status-session", "session-1"]), {
    command: "status-session",
    runId: "session-1",
  });
  assert.deepEqual(
    parseCliArgs(["review-session", "session-1", "--project", "/repo"]),
    {
      command: "review-session",
      runId: "session-1",
      project: "/repo",
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "export-bundle",
      "run-1",
      "--output",
      "./run.jsonl",
      "--project",
      "/repo",
    ]),
    {
      command: "export-bundle",
      runId: "run-1",
      output: "./run.jsonl",
      project: "/repo",
    },
  );
  assert.deepEqual(
    parseCliArgs(["verify-bundle", "--bundle", "./run.jsonl"]),
    {
      command: "verify-bundle",
      bundle: "./run.jsonl",
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "attest-bundle",
      "--bundle",
      "./run.jsonl",
      "--private-key",
      "./signer-private.pem",
      "--output",
      "./run.attestation.jsonl",
    ]),
    {
      command: "attest-bundle",
      bundle: "./run.jsonl",
      privateKey: "./signer-private.pem",
      output: "./run.attestation.jsonl",
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "verify-attestation",
      "--bundle",
      "./run.jsonl",
      "--attestation",
      "./run.attestation.jsonl",
      "--public-key",
      "./signer-public.pem",
    ]),
    {
      command: "verify-attestation",
      bundle: "./run.jsonl",
      attestation: "./run.attestation.jsonl",
      publicKey: "./signer-public.pem",
    },
  );
});

test("parses run-session with exact frozen launch inputs", () => {
  assert.deepEqual(
    parseCliArgs([
      "run-session",
      "session-1",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
      "--risk-tier",
      "low",
      "--retry-codes",
      "retry-codes.json",
      "--state-dir",
      "/repo/.harness",
    ]),
    {
      command: "run-session",
      project: "/repo",
      skill: "skill.json",
      input: "input.json",
      policy: "policy.json",
      context: "context.json",
      riskTier: "low",
      retryCodes: "retry-codes.json",
      stateDir: "/repo/.harness",
      runId: "session-1",
    },
  );
});

test("parses resume-session with only project and state directory", () => {
  assert.deepEqual(
    parseCliArgs([
      "resume-session",
      "session-1",
      "--project",
      "/repo",
      "--state-dir",
      "/repo/.harness",
    ]),
    {
      command: "resume-session",
      project: "/repo",
      stateDir: "/repo/.harness",
      runId: "session-1",
    },
  );
});

test("rejects unknown commands and flags with usage errors", () => {
  assert.throws(
    () => parseCliArgs(["unknown"]),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  assert.throws(
    () => parseCliArgs(["init", "--unknown", "x"]),
    (error) =>
      error.code === "usage_error" && error.details.flag === "--unknown",
  );
});

test("rejects duplicate flags missing values and flag equals syntax", () => {
  assert.throws(
    () => parseCliArgs(["init", "--project", "/repo", "--project", "/other"]),
    /Duplicate flag/,
  );
  assert.throws(
    () => parseCliArgs(["run", "--project"]),
    /Missing value/,
  );
  assert.throws(
    () => parseCliArgs(["run", "--project=/repo"]),
    /Unknown flag/,
  );
  for (const command of ["status-session", "review-session"]) {
    assert.throws(() => parseCliArgs([command]), /positional argument count/);
    assert.throws(
      () => parseCliArgs([command, "session-1", "extra"]),
      /positional argument count/,
    );
    assert.throws(
      () => parseCliArgs([command, "session-1", "--unknown", "x"]),
      /Unknown flag/,
    );
    assert.throws(
      () => parseCliArgs([
        command,
        "session-1",
        "--project",
        "/repo",
        "--project",
        "/other",
      ]),
      /Duplicate flag/,
    );
  }
});

test("run-session rejects missing duplicate unknown extra flags and unsafe ids", () => {
  assert.throws(
    () => parseCliArgs([
      "run-session",
      "session-1",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
    ]),
    /Missing required flag '--risk-tier'/,
  );
  assert.throws(
    () => parseCliArgs([
      "run-session",
      "session-1",
      "--project",
      "/repo",
      "--project",
      "/other",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
      "--risk-tier",
      "low",
    ]),
    /Duplicate flag/,
  );
  assert.throws(
    () => parseCliArgs([
      "run-session",
      "session-1",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
      "--risk-tier",
      "low",
      "--model",
      "gpt-5.5",
    ]),
    /Unknown flag/,
  );
  assert.throws(
    () => parseCliArgs([
      "run-session",
      "session-1",
      "extra",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
      "--risk-tier",
      "low",
    ]),
    /positional argument count/,
  );
  assert.throws(
    () => parseCliArgs([
      "run-session",
      "../session-1",
      "--project",
      "/repo",
      "--skill",
      "skill.json",
      "--input",
      "input.json",
      "--policy",
      "policy.json",
      "--context",
      "context.json",
      "--risk-tier",
      "low",
    ]),
    /Invalid run id/,
  );
});

test("resume-session rejects every authority override by flag admission", () => {
  for (const flag of [
    "--skill",
    "--input",
    "--policy",
    "--context",
    "--risk-tier",
    "--retry-codes",
    "--executor",
    "--model",
    "--reasoning",
    "--route",
  ]) {
    assert.throws(
      () => parseCliArgs(["resume-session", "session-1", flag, "override"]),
      (error) =>
        error.code === "usage_error" &&
        error.exitCode === 2 &&
        error.details.flag === flag,
      flag,
    );
  }
});

test("rejects missing required flags extra positionals and unsupported executor", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "run",
        "--project",
        "/repo",
        "--skill",
        "skill.json",
        "--executor",
        "deterministic",
      ]),
    /Missing required flag '--input'/,
  );
  assert.throws(
    () => parseCliArgs(["export-bundle", "run-1"]),
    /Missing required flag '--output'/,
  );
  assert.throws(
    () => parseCliArgs(["verify-bundle"]),
    /Missing required flag '--bundle'/,
  );
  assert.throws(
    () => parseCliArgs(["verify-bundle", "run-1", "--bundle", "x"]),
    /Invalid positional argument count/,
  );
  assert.throws(
    () => parseCliArgs(["verify-bundle", "--bundle", "x", "--project", "/repo"]),
    /Unknown flag/,
  );
  assert.throws(
    () => parseCliArgs(["attest-bundle", "--bundle", "x"]),
    /Missing required flag '--private-key'/,
  );
  assert.throws(
    () => parseCliArgs([
      "verify-attestation",
      "--bundle",
      "x",
      "--attestation",
      "x.attestation",
    ]),
    /Missing required flag '--public-key'/,
  );
  assert.throws(
    () => parseCliArgs([
      "verify-attestation",
      "run-1",
      "--bundle",
      "x",
      "--attestation",
      "x.attestation",
      "--public-key",
      "public.pem",
    ]),
    /Invalid positional argument count/,
  );
  assert.throws(
    () => parseCliArgs(["status", "run-1", "extra"]),
    /Invalid positional argument count/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "run",
        "--project",
        "/repo",
        "--skill",
        "skill.json",
        "--executor",
        "shell",
        "--input",
        "input.json",
      ]),
    /Unsupported executor/,
  );
});

test("rejects malformed approval hashes", () => {
  for (const approve of ["A".repeat(64), "a".repeat(63), "not-a-sha"]) {
    assert.throws(
      () => parseCliArgs(["apply", "run-1", "--approve", approve]),
      /lowercase SHA-256/,
    );
  }
});

test("rejects unsafe run ids before path construction", () => {
  for (const command of [
    "status",
    "receipt",
    "review",
    "status-session",
    "review-session",
    "run-session",
    "resume-session",
    "export-bundle",
  ]) {
    for (const runId of ["../run-1", "nested/run-1", ".hidden", "-bad"]) {
      assert.throws(
        () => parseCliArgs(
          command === "export-bundle"
            ? [command, runId, "--output", "bundle.jsonl"]
            : [command, runId],
        ),
        (error) => error.code === "usage_error" && error.exitCode === 2,
      );
    }
  }

  assert.throws(
    () => parseCliArgs(["apply", "run/1", "--approve", sha]),
    /Invalid run id/,
  );
  assert.throws(
    () => parseCliArgs(["status", "a".repeat(129)]),
    /Invalid run id/,
  );
});
