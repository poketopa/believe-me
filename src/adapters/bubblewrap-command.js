import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  validateHermeticBoundary,
  validateHermeticBoundaryRefusal,
} from "../contracts/hermetic-boundary.js";
import { safetyRefusal, usageError } from "../contracts/errors.js";

const DEFAULT_BUBBLEWRAP_PATH = "/usr/bin/bwrap";
const VERSION_PATTERN = /^bubblewrap ([0-9]+\.[0-9]+\.[0-9]+)\n?$/u;
const REQUIRED_FLAGS = Object.freeze([
  "--clearenv",
  "--die-with-parent",
  "--disable-userns",
  "--new-session",
  "--unshare-ipc",
  "--unshare-net",
  "--unshare-pid",
  "--unshare-user",
  "--unshare-uts",
]);

function refuse(code, hostPlatform, message, backendKind = "bubblewrap") {
  const refusal = validateHermeticBoundaryRefusal({
    schema_version: { major: 1 },
    status: "refused",
    code,
    backend_kind: backendKind,
    host_platform: hostPlatform,
    message,
  });
  throw safetyRefusal("Hermetic command verifier refused before execution.", {
    refusal,
  });
}

function inspectOutput(executable, argument, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(executable, [argument], {
      encoding: "utf8",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      timeout: 2_000,
      maxBuffer: 4_096,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null || stderr !== "") {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function supportedVersion(stdout) {
  const match = VERSION_PATTERN.exec(stdout ?? "");
  if (match === null) return null;
  const parts = match[1].split(".").map(Number);
  if (parts[0] !== 0 || parts[1] < 11 || (parts[1] === 11 && parts[2] < 2)) {
    return null;
  }
  return `bwrap-${match[1]}`;
}

function executableIdentity(stats) {
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    modified_ns: stats.mtimeNs.toString(),
  });
}

function sameExecutableIdentity(left, right) {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified_ns === right.modified_ns;
}

export async function inspectBubblewrapBackend(options = {}) {
  const executable = options.executable ?? DEFAULT_BUBBLEWRAP_PATH;
  const execFileImpl = options.execFileImpl ?? execFile;
  if (!isAbsolute(executable) || typeof execFileImpl !== "function") {
    throw usageError("Bubblewrap inspection requires an absolute executable and execFile.");
  }
  const stats = await lstat(executable, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    stats === null ||
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o111n) === 0n
  ) {
    return Object.freeze({ available: false });
  }
  const versionOutput = await inspectOutput(executable, "--version", execFileImpl);
  const helpOutput = await inspectOutput(executable, "--help", execFileImpl);
  const runtimeIdentity = supportedVersion(versionOutput);
  if (
    runtimeIdentity === null ||
    helpOutput === null ||
    REQUIRED_FLAGS.some((flag) => !helpOutput.includes(flag))
  ) {
    return Object.freeze({ available: false });
  }
  return Object.freeze({
    available: true,
    executable,
    runtime_identity: runtimeIdentity,
    file_identity: executableIdentity(stats),
  });
}

function validateInspection(value) {
  if (value?.available === false) return value;
  if (
    value?.available !== true ||
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    typeof value.runtime_identity !== "string"
  ) {
    throw usageError("Bubblewrap backend inspector returned an invalid capability record.");
  }
  if (
    value.file_identity !== undefined &&
    (
      value.file_identity === null ||
      typeof value.file_identity !== "object" ||
      ["device", "inode", "size", "modified_ns"].some(
        (field) => typeof value.file_identity[field] !== "string",
      )
    )
  ) {
    throw usageError("Bubblewrap backend inspector returned an invalid file identity.");
  }
  return value;
}

function sandboxCommand(command) {
  return command.startsWith("./") ? `/workspace/${command.slice(2)}` : command;
}

function bubblewrapArgs(root, spec) {
  return Object.freeze([
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-net",
    "--unshare-uts",
    "--disable-userns",
    "--clearenv",
    "--setenv", "CI", "true",
    "--setenv", "HOME", "/nonexistent",
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "TMPDIR", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/workspace",
    "--bind", root, "/workspace",
    "--chdir", "/workspace",
    "--",
    sandboxCommand(spec.command),
    ...spec.args,
  ]);
}

export async function prepareBubblewrapCommand({
  boundary,
  hostPlatform,
  inspectBackend = inspectBubblewrapBackend,
  root,
  spec,
}) {
  const frozen = validateHermeticBoundary(boundary);
  if (hostPlatform !== "linux" || frozen.platform.host !== "linux") {
    refuse(
      "platform_unsupported",
      hostPlatform,
      "Bubblewrap hermetic execution requires a supported Linux host.",
    );
  }
  if (frozen.backend.kind !== "bubblewrap") {
    refuse(
      "backend_unsupported",
      hostPlatform,
      "The requested hermetic backend is not supported for command verification.",
      frozen.backend.kind,
    );
  }
  if (typeof inspectBackend !== "function") {
    throw usageError("inspectBackend must be a function.");
  }
  const inspected = validateInspection(await inspectBackend());
  if (!inspected.available) {
    refuse(
      "backend_missing",
      hostPlatform,
      "The configured bubblewrap backend is unavailable.",
    );
  }
  if (inspected.runtime_identity !== frozen.backend.runtime_identity) {
    refuse(
      "runtime_identity_mismatch",
      hostPlatform,
      "The bubblewrap runtime identity does not match frozen authority.",
    );
  }
  if (inspected.file_identity !== undefined) {
    const stats = await lstat(inspected.executable, { bigint: true }).catch(() => null);
    if (
      stats === null ||
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      !sameExecutableIdentity(inspected.file_identity, executableIdentity(stats))
    ) {
      refuse(
        "runtime_identity_mismatch",
        hostPlatform,
        "The bubblewrap executable changed after capability inspection.",
      );
    }
  }
  return Object.freeze({
    command: inspected.executable,
    args: bubblewrapArgs(root, spec),
  });
}
