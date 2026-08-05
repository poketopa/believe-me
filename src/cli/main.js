import { product } from "../product.js";
import { parseCliArgs } from "./args.js";
import { executeCliCommand } from "./commands.js";
import { formatJsonlError, formatJsonlSuccess } from "./jsonl.js";

export function cliHelpText() {
  return [
    `${product.name} ${product.version}`,
    "",
    "A verifiable execution harness for AI code changes.",
    "",
    "Usage:",
    "  verifiable-agent-harness init [--project <path>] [--state-dir <path>]",
    "  verifiable-agent-harness run --project <path> --skill <path> --executor <deterministic|codex> --input <path> [--state-dir <path>]",
    "  verifiable-agent-harness status <run-id> [--project <path>] [--state-dir <path>]",
    "  verifiable-agent-harness receipt <run-id> [--project <path>] [--state-dir <path>]",
    "  verifiable-agent-harness apply <run-id> --approve <receipt-sha256> [--project <path>] [--state-dir <path>]",
    "",
    "Command results are emitted as one canonical JSONL record.",
    "Help and version output remain plain text.",
    "",
  ].join("\n");
}

function outputWriter(value, fallback) {
  return value && typeof value.write === "function" ? value : fallback;
}

export async function runCli(argv, options = {}) {
  const stdout = outputWriter(options.stdout, process.stdout);
  const stderr = outputWriter(options.stderr, process.stderr);
  const [first] = argv;

  if (first === "--version" || first === "-v") {
    stdout.write(`${product.version}\n`);
    return 0;
  }

  if (first === undefined || first === "--help" || first === "-h") {
    stdout.write(cliHelpText());
    return 0;
  }

  let command = first;
  try {
    const parsed = parseCliArgs(argv);
    command = parsed.command;
    const data = await (options.executeCliCommand ?? executeCliCommand)(
      parsed,
      options,
    );
    const formatted = formatJsonlSuccess(command, data);
    stdout.write(formatted.line);
    return formatted.exitCode;
  } catch (error) {
    const formatted = formatJsonlError(command, error);
    stderr.write(formatted.line);
    return formatted.exitCode;
  }
}
