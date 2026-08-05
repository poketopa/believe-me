#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "scripts", "src", "test"];
const excludedDirectories = new Set([".gradle", "build", "node_modules"]);

function javascriptFiles(root) {
  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
        pending.push(path);
      } else if (entry.isFile() && extname(entry.name) === ".js") {
        files.push(path);
      }
    }
  }

  return files.sort();
}

for (const file of roots.flatMap(javascriptFiles).sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
