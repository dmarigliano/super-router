import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stableHash } from "./utils.ts";

export interface ProjectContext {
  cwd: string;
  projectId: string;
  branch?: string;
  commit?: string;
  verificationCommands: string[];
}

export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const GIT_PROBE_TIMEOUT_MS = 1_500;
const GIT_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

function readPackageScripts(cwd: string): Record<string, string> {
  const path = resolve(cwd, "package.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_PACKAGE_JSON_BYTES) return {};

    const buffer = Buffer.alloc(metadata.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const finalMetadata = fstatSync(descriptor);
    if (
      bytesRead !== metadata.size ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs
    ) {
      return {};
    }

    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("scripts" in parsed)) return {};
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Verification discovery is advisory and must fail safely.
      }
    }
  }
}

function packageRunner(cwd: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(resolve(cwd, "bun.lock")) || existsSync(resolve(cwd, "bun.lockb"))) return "bun";
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export function discoverVerificationCommands(cwd: string): string[] {
  const scripts = readPackageScripts(cwd);
  const runner = packageRunner(cwd);
  if (scripts.check) return [`${runner} run check`];

  const commands = ["typecheck", "lint", "test", "build"]
    .filter((script) => Boolean(scripts[script]))
    .map((script) => `${runner} run ${script}`);
  if (commands.length) return commands;

  if (existsSync(resolve(cwd, "Cargo.toml"))) return ["cargo test", "cargo clippy"];
  if (existsSync(resolve(cwd, "go.mod"))) return ["go test ./..."];
  if (existsSync(resolve(cwd, "pyproject.toml")) || existsSync(resolve(cwd, "pytest.ini"))) {
    return ["pytest"];
  }
  return [];
}

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || undefined;
}

export function inspectProject(cwd: string): ProjectContext {
  const root = gitValue(cwd, ["rev-parse", "--show-toplevel"]) ?? resolve(cwd);
  const remote = gitValue(root, ["remote", "get-url", "origin"]);
  const branch = gitValue(root, ["branch", "--show-current"]);
  const commit = gitValue(root, ["rev-parse", "HEAD"]);
  const identity = `${localProjectIdentity(root)}\0${remote ?? "no-origin"}`;
  return {
    cwd: root,
    projectId: stableHash(identity).slice(0, 24),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    verificationCommands: discoverVerificationCommands(root),
  };
}

function localProjectIdentity(root: string): string {
  const commonDir = gitValue(root, ["rev-parse", "--git-common-dir"]);
  const identityPath = commonDir
    ? isAbsolute(commonDir)
      ? commonDir
      : resolve(root, commonDir)
    : root;
  try {
    const canonical = realpathSync(identityPath);
    const metadata = statSync(canonical);
    return `${canonical}:${metadata.dev}:${metadata.ino}`;
  } catch {
    // The canonical local path still separates ordinary clones if metadata is
    // temporarily unavailable. It is never replaced by forgeable remote data.
    return resolve(identityPath);
  }
}
