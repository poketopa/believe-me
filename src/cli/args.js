import { usageError } from "../contracts/errors.js";

const commands = Object.freeze({
  init: Object.freeze({
    flags: Object.freeze(["project", "state-dir"]),
    requiredFlags: Object.freeze([]),
    positionals: 0,
  }),
  run: Object.freeze({
    flags: Object.freeze(["project", "skill", "executor", "input", "state-dir"]),
    requiredFlags: Object.freeze(["project", "skill", "executor", "input"]),
    positionals: 0,
  }),
  status: Object.freeze({
    flags: Object.freeze(["project", "state-dir"]),
    requiredFlags: Object.freeze([]),
    positionals: 1,
  }),
  receipt: Object.freeze({
    flags: Object.freeze(["project", "state-dir"]),
    requiredFlags: Object.freeze([]),
    positionals: 1,
  }),
  apply: Object.freeze({
    flags: Object.freeze(["approve", "project", "state-dir"]),
    requiredFlags: Object.freeze(["approve"]),
    positionals: 1,
  }),
  "apply-session": Object.freeze({
    flags: Object.freeze(["approve", "project", "state-dir"]),
    requiredFlags: Object.freeze(["approve"]),
    positionals: 1,
  }),
});

const commandNames = Object.freeze(Object.keys(commands));
const executors = Object.freeze(["deterministic", "codex"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function camelCaseFlag(flag) {
  return flag.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function assertNonEmptyValue(flag, value) {
  if (value === undefined || value.startsWith("--") || value === "") {
    throw usageError(`Missing value for '--${flag}'.`, { flag });
  }
}

function readFlagsAndPositionals(command, tokens) {
  const spec = commands[command];
  const admitted = new Set(spec.flags);
  const seen = new Set();
  const parsed = {};
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const flag = token.slice(2);
    if (flag === "" || flag.includes("=") || !admitted.has(flag)) {
      throw usageError(`Unknown flag '${token}' for '${command}'.`, {
        command,
        flag: token,
      });
    }
    if (seen.has(flag)) {
      throw usageError(`Duplicate flag '--${flag}'.`, { command, flag });
    }

    const value = tokens[index + 1];
    assertNonEmptyValue(flag, value);
    seen.add(flag);
    parsed[camelCaseFlag(flag)] = value;
    index += 1;
  }

  if (positionals.length !== spec.positionals) {
    throw usageError(`Invalid positional argument count for '${command}'.`, {
      command,
      expected: spec.positionals,
      actual: positionals.length,
    });
  }

  for (const flag of spec.requiredFlags) {
    if (!seen.has(flag)) {
      throw usageError(`Missing required flag '--${flag}' for '${command}'.`, {
        command,
        flag,
      });
    }
  }

  return { parsed, positionals };
}

function validateParsed(command, parsed) {
  if (parsed.executor !== undefined && !executors.includes(parsed.executor)) {
    throw usageError(`Unsupported executor '${parsed.executor}'.`, {
      executor: parsed.executor,
      supported: executors,
    });
  }

  if (parsed.approve !== undefined && !sha256Pattern.test(parsed.approve)) {
    throw usageError("'--approve' must be a lowercase SHA-256 hex digest.", {
      flag: "approve",
    });
  }

  return parsed;
}

function validateRunId(command, runId) {
  if (!runIdPattern.test(runId)) {
    throw usageError(`Invalid run id for '${command}'.`, {
      command,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    });
  }
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) {
    throw usageError("argv must be an array of strings.");
  }
  if (!argv.every((token) => typeof token === "string")) {
    throw usageError("argv must contain only strings.");
  }

  const [command, ...tokens] = argv;
  if (command === undefined) {
    throw usageError("Missing command.", { commands: commandNames });
  }
  if (!Object.hasOwn(commands, command)) {
    throw usageError(`Unknown command '${command}'.`, {
      command,
      commands: commandNames,
    });
  }

  const { parsed, positionals } = readFlagsAndPositionals(command, tokens);
  validateParsed(command, parsed);

  const result = { command, ...parsed };
  if (positionals.length === 1) {
    validateRunId(command, positionals[0]);
    result.runId = positionals[0];
  }

  return Object.freeze(result);
}
