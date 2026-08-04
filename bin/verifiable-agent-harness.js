#!/usr/bin/env node

import { product } from "../src/index.js";

const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  process.stdout.write(`${product.version}\n`);
  process.exit(0);
}

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(
    [
      `${product.name} ${product.version}`,
      "",
      "A verifiable execution harness for AI code changes.",
      "",
      "Commands planned for v0.1:",
      "  init     initialize project-local policy",
      "  run      execute a change in isolation",
      "  status   inspect a durable run",
      "  receipt  verify execution evidence",
      "  apply    apply an approved verified change",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

process.stderr.write(`Command not implemented yet: ${command}\n`);
process.exit(1);
