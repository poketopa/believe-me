import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../src/cli/args.js";

const sha = "a".repeat(64);

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
  for (const command of ["status", "receipt", "review", "export-bundle"]) {
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
