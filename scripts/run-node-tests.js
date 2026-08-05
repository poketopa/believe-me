import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";

const TEST_ROOT = resolve("test");
const EXCLUDED_DIRECTORIES = new Set(["fixtures"]);

async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...await discoverTests(join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const testFiles = (await discoverTests(TEST_ROOT))
  .map((path) => relative(process.cwd(), path))
  .sort();

if (testFiles.length === 0) {
  throw new Error("No Node test files were discovered.");
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  shell: false,
});

child.once("error", (error) => {
  throw error;
});

child.once("close", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
