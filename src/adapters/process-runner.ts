import { spawn } from "node:child_process";

export interface ProcessInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  input?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** `replace` starts from an empty environment; `inherit` overlays the runner base environment. */
  envMode?: "inherit" | "replace";
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  readonly result: ProcessResult;

  constructor(message: string, result: ProcessResult) {
    super(message);
    this.name = "ProcessExecutionError";
    this.result = result;
  }
}

export interface SpawnProcessRunnerOptions {
  defaultMaxOutputBytes?: number;
  killGraceMs?: number;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Uses a dedicated Unix process group so timeout/abort also reaches descendants. */
  terminateProcessGroup?: boolean;
}

/** Executes an argv vector directly. It never invokes a shell. */
export class SpawnProcessRunner implements ProcessRunner {
  readonly #defaultMaxOutputBytes: number;
  readonly #killGraceMs: number;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #terminateProcessGroup: boolean;

  constructor(options: SpawnProcessRunnerOptions = {}) {
    this.#defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 8 * 1024 * 1024;
    this.#killGraceMs = options.killGraceMs ?? 1_000;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#terminateProcessGroup =
      (options.terminateProcessGroup ?? true) && process.platform !== "win32";
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    validateInvocation(invocation);
    const startedAt = Date.now();
    const limit = invocation.maxOutputBytes ?? this.#defaultMaxOutputBytes;

    return await new Promise<ProcessResult>((resolve, reject) => {
      const useProcessGroup = this.#terminateProcessGroup;
      const child = spawn(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: buildEnvironment(this.#baseEnv, invocation.env, invocation.envMode ?? "inherit"),
        detached: useProcessGroup,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillSent = false;
      let terminationRequested = false;
      let pendingClose: { result: ProcessResult; outputLimitExceeded: boolean } | undefined;

      const signalProcess = (signal: NodeJS.Signals): boolean => {
        if (useProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return true;
          } catch (error) {
            if (!isMissingProcess(error)) return false;
          }
        }
        return child.exitCode === null && child.signalCode === null ? child.kill(signal) : false;
      };

      const finish = (result: ProcessResult, outputLimitExceeded: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        invocation.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          reject(
            new ProcessExecutionError(`Process timed out after ${invocation.timeoutMs}ms`, result),
          );
        } else if (outputLimitExceeded) {
          reject(new ProcessExecutionError(`Process output exceeded ${limit} bytes`, result));
        } else if (invocation.signal?.aborted) {
          reject(new ProcessExecutionError("Process was aborted", result));
        } else {
          resolve(result);
        }
      };

      const terminate = (): void => {
        if (terminationRequested) return;
        terminationRequested = true;
        signalProcess("SIGTERM");
        forceKillTimer = setTimeout(() => {
          forceKillSent = true;
          signalProcess("SIGKILL");
          if (pendingClose) finish(pendingClose.result, pendingClose.outputLimitExceeded);
        }, this.#killGraceMs);
        forceKillTimer.unref?.();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, invocation.timeoutMs);
      timeout.unref?.();

      const onAbort = (): void => terminate();
      invocation.signal?.addEventListener("abort", onAbort, { once: true });

      const capture = (target: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > limit) {
          terminate();
          return;
        }
        target.push(buffer);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
      // A child may exit before consuming stdin. EPIPE is represented by the
      // process result and must not become an unhandled stream error.
      child.stdin?.on("error", () => {});

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        invocation.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        const result: ProcessResult = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          timedOut,
        };
        const outputLimitExceeded = outputBytes > limit;
        if (terminationRequested && useProcessGroup && !forceKillSent && child.pid) {
          if (processGroupExists(child.pid)) {
            pendingClose = { result, outputLimitExceeded };
            return;
          }
        }
        finish(result, outputLimitExceeded);
      });

      if (invocation.input !== undefined) child.stdin?.end(invocation.input);
      else child.stdin?.end();
      if (invocation.signal?.aborted) terminate();
    });
  }
}

function buildEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  override: Readonly<Record<string, string | undefined>> | undefined,
  mode: "inherit" | "replace",
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (mode === "inherit") {
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function validateInvocation(invocation: ProcessInvocation): void {
  if (!invocation.executable || invocation.executable.includes("\0")) {
    throw new Error("A valid executable is required");
  }
  if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
    throw new Error("timeoutMs must be greater than zero");
  }
  if (
    invocation.maxOutputBytes !== undefined &&
    (!Number.isFinite(invocation.maxOutputBytes) || invocation.maxOutputBytes <= 0)
  ) {
    throw new Error("maxOutputBytes must be greater than zero");
  }
  if (invocation.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Process arguments cannot contain null bytes");
  }
}
