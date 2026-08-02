import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProcessRunner } from "../adapters/process-runner.ts";
import { SpawnProcessRunner } from "../adapters/process-runner.ts";
import { minimalVerificationEnvironment } from "./verification.ts";

export interface WorkspaceFingerprint {
  digest: string;
  source: "git" | "filesystem";
  filesInspected: number;
  bytesHashed: number;
  complete: boolean;
}

export interface WorkspaceChangeDetector {
  fingerprint(cwd: string, signal?: AbortSignal): Promise<WorkspaceFingerprint>;
}

export interface BoundedWorkspaceChangeDetectorOptions {
  runner?: ProcessRunner;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  maxDurationMs?: number;
  ignoredDirectories?: readonly string[];
}

const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  ".super-router",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
];
const SUPPORTS_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0;
const FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);

/**
 * Fingerprints only changed Git paths when possible, so a pre-existing dirty
 * tree becomes the baseline. Non-Git workspaces use a bounded no-symlink walk.
 */
export class BoundedWorkspaceChangeDetector implements WorkspaceChangeDetector {
  readonly #runner: ProcessRunner;
  readonly #maxFiles: number;
  readonly #maxBytes: number;
  readonly #maxFileBytes: number;
  readonly #maxDurationMs: number;
  readonly #ignoredDirectories: ReadonlySet<string>;

  constructor(options: BoundedWorkspaceChangeDetectorOptions = {}) {
    this.#runner = options.runner ?? new SpawnProcessRunner();
    this.#maxFiles = options.maxFiles ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.#maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.#maxDurationMs = options.maxDurationMs ?? 5_000;
    this.#ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    for (const [name, value] of [
      ["maxFiles", this.#maxFiles],
      ["maxBytes", this.#maxBytes],
      ["maxFileBytes", this.#maxFileBytes],
      ["maxDurationMs", this.#maxDurationMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
  }

  async fingerprint(cwd: string, signal?: AbortSignal): Promise<WorkspaceFingerprint> {
    const git = await this.#gitFingerprint(cwd, signal);
    if (git) return git;
    return await this.#filesystemFingerprint(cwd, signal);
  }

  async #gitFingerprint(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFingerprint | undefined> {
    const invocation = {
      executable: "git",
      cwd,
      timeoutMs: this.#maxDurationMs,
      maxOutputBytes: Math.min(this.#maxBytes, 16 * 1024 * 1024),
      env: minimalVerificationEnvironment(),
      envMode: "replace" as const,
      ...(signal ? { signal } : {}),
    };
    let status: Awaited<ReturnType<ProcessRunner["run"]>>;
    try {
      status = await this.#runner.run({
        ...invocation,
        args: [
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
        ],
      });
    } catch {
      return undefined;
    }
    if (status.exitCode !== 0) return undefined;

    const paths = changedPaths(status.stdout).filter((path) => !this.#isIgnored(path));
    const normalizedStatus = paths.join("\0");
    const hash = createHash("sha256");
    hash.update("git-status\0").update(normalizedStatus);
    let bytesHashed = Buffer.byteLength(normalizedStatus);
    let complete = true;

    // Tracked worktree/index changes are exact while they remain within the
    // process-output bound. Status + file hashing remains as a fallback.
    try {
      const diff = await this.#runner.run({
        ...invocation,
        args: [
          "-c",
          "core.fsmonitor=false",
          "diff",
          "--no-ext-diff",
          "--ignore-submodules=all",
          "--binary",
          "--no-color",
          "HEAD",
          "--",
        ],
      });
      if (diff.exitCode === 0) {
        hash.update("\0git-diff\0").update(diff.stdout);
        bytesHashed += Buffer.byteLength(diff.stdout);
      } else {
        complete = false;
      }
    } catch {
      complete = false;
    }

    const inspection = await this.#hashPaths(hash, cwd, paths, bytesHashed, signal);
    return {
      digest: hash.digest("hex"),
      source: "git",
      filesInspected: inspection.filesInspected,
      bytesHashed: inspection.bytesHashed,
      complete: complete && inspection.complete,
    };
  }

  async #filesystemFingerprint(cwd: string, signal?: AbortSignal): Promise<WorkspaceFingerprint> {
    const startedAt = Date.now();
    const hash = createHash("sha256");
    const queue = [cwd];
    const paths: string[] = [];
    let complete = true;
    let entriesInspected = 0;

    while (queue.length > 0 && entriesInspected < this.#maxFiles) {
      if (signal?.aborted) throw new Error("Workspace fingerprint was aborted");
      if (Date.now() - startedAt > this.#maxDurationMs) {
        complete = false;
        break;
      }
      const directory = queue.shift();
      if (!directory) break;
      const entries = [];
      const handle = await opendir(directory);
      for await (const entry of handle) {
        entries.push(entry);
        if (Date.now() - startedAt > this.#maxDurationMs) {
          complete = false;
          break;
        }
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (this.#isIgnored(entry.name)) continue;
        entriesInspected += 1;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else paths.push(path);
        if (entriesInspected >= this.#maxFiles) {
          complete = false;
          break;
        }
      }
      queue.sort((left, right) => left.localeCompare(right));
    }

    const inspection = await this.#hashPaths(hash, cwd, paths, 0, signal);
    return {
      digest: hash.digest("hex"),
      source: "filesystem",
      filesInspected: inspection.filesInspected,
      bytesHashed: inspection.bytesHashed,
      complete: complete && inspection.complete,
    };
  }

  async #hashPaths(
    hash: ReturnType<typeof createHash>,
    cwd: string,
    paths: readonly string[],
    initialBytes: number,
    signal?: AbortSignal,
  ): Promise<{ filesInspected: number; bytesHashed: number; complete: boolean }> {
    let bytesHashed = initialBytes;
    let filesInspected = 0;
    let complete = true;
    const startedAt = Date.now();
    for (const rawPath of paths.slice(0, this.#maxFiles)) {
      if (signal?.aborted) throw new Error("Workspace fingerprint was aborted");
      if (Date.now() - startedAt > this.#maxDurationMs || bytesHashed >= this.#maxBytes) {
        complete = false;
        break;
      }
      const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
      const relation = relative(cwd, path);
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        complete = false;
        continue;
      }
      hash.update("\0path\0").update(relation);
      try {
        const handle = await open(path, FILE_OPEN_FLAGS);
        try {
          const metadata = await handle.stat();
          hash.update(`\0${metadata.mode}:${metadata.size}\0`);
          const pathMetadata = SUPPORTS_NOFOLLOW ? undefined : await lstat(path);
          if (pathMetadata?.isSymbolicLink()) {
            hash.update("\0symlink\0").update(await readlink(path));
          } else if (pathMetadata && !sameFile(pathMetadata, metadata)) {
            complete = false;
            hash.update("\0changed\0");
          } else if (metadata.isFile()) {
            const remaining = Math.max(0, this.#maxBytes - bytesHashed);
            const bytesToRead = Math.min(metadata.size, this.#maxFileBytes, remaining);
            const buffer = Buffer.alloc(bytesToRead);
            const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
            hash.update(buffer.subarray(0, bytesRead));
            bytesHashed += bytesRead;
            if (bytesRead < metadata.size) {
              complete = false;
              hash.update(`\0truncated:${metadata.mtimeMs}\0`);
            }
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isNoFollowSymlinkError(error)) {
          hash.update("\0symlink\0");
          try {
            hash.update(await readlink(path));
          } catch (linkError) {
            if (!isMissing(linkError)) complete = false;
            hash.update("\0missing\0");
          }
        } else {
          if (!isMissing(error)) complete = false;
          hash.update("\0missing\0");
        }
      }
      filesInspected += 1;
    }
    if (paths.length > this.#maxFiles) complete = false;
    return { filesInspected, bytesHashed, complete };
  }

  #isIgnored(path: string): boolean {
    return path
      .split(/[\\/]/)
      .filter(Boolean)
      .some((segment) => this.#ignoredDirectories.has(segment));
  }
}

function changedPaths(status: string): string[] {
  const fields = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (const field of fields) {
    paths.push(field.length >= 4 && field[2] === " " ? field.slice(3) : field);
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNoFollowSymlinkError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK")
  );
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
