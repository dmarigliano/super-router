import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProcessRunner } from "../adapters/process-runner.ts";
import { SpawnProcessRunner } from "../adapters/process-runner.ts";
import type { PlanNode, StepResult, VerificationResult } from "../contracts.ts";
import { classifyAction, type OperationalPolicy } from "../security/policy.ts";
import { redactText } from "../security/redaction.ts";

export interface VerificationContext {
  cwd: string;
  runId: string;
  node: PlanNode;
  step: StepResult;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VerificationRunner {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export type CommandValidator = (args: readonly string[]) => boolean | string;

export interface SafeVerificationRunnerOptions {
  runner?: ProcessRunner;
  allowlist?: readonly string[] | Readonly<Record<string, CommandValidator>>;
  maxOutputBytes?: number;
  policy?: OperationalPolicy;
  independentReviewer?: (context: VerificationContext) => Promise<{
    passed: boolean;
    details: string;
  }>;
  humanApproval?: (context: VerificationContext) => Promise<boolean>;
  environment?: Readonly<Record<string, string | undefined>>;
}

interface CheckResult {
  name: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

const SAFE_SCRIPT_NAMES = new Set(["build", "check", "lint", "test", "typecheck"]);

const DEFAULT_ALLOWLIST: Readonly<Record<string, CommandValidator>> = {
  bun: validatePackageRunner,
  npm: validatePackageRunner,
  pnpm: validatePackageRunner,
  yarn: validatePackageRunner,
  tsc: () => true,
  biome: (args) => ["check", "lint", "format"].includes(args[0] ?? ""),
  eslint: () => true,
  vitest: () => true,
  jest: () => true,
  pytest: () => true,
  ruff: (args) => args[0] === "check" || args[0] === "format",
  mypy: () => true,
  cargo: (args) => ["check", "clippy", "fmt", "test"].includes(args[0] ?? ""),
  go: (args) => args[0] === "test" || args[0] === "vet",
  git: (args) =>
    ["diff", "grep", "log", "ls-files", "rev-parse", "show", "status"].includes(args[0] ?? ""),
};

export class SafeVerificationRunner implements VerificationRunner {
  readonly #runner: ProcessRunner;
  readonly #allowlist: Readonly<Record<string, CommandValidator>>;
  readonly #maxOutputBytes: number;
  readonly #policy: OperationalPolicy | undefined;
  readonly #independentReviewer?: SafeVerificationRunnerOptions["independentReviewer"];
  readonly #humanApproval?: SafeVerificationRunnerOptions["humanApproval"];
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: SafeVerificationRunnerOptions = {}) {
    this.#runner = options.runner ?? new SpawnProcessRunner();
    this.#allowlist = normalizeAllowlist(options.allowlist);
    this.#maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.#policy = options.policy;
    this.#independentReviewer = options.independentReviewer;
    this.#humanApproval = options.humanApproval;
    this.#environment = options.environment ?? minimalVerificationEnvironment();
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const startedAt = Date.now();
    const hasProviderOutput = context.step.output.trim().length > 0;
    const checks: CheckResult[] = [
      {
        name: "provider-output",
        passed: hasProviderOutput,
        details: hasProviderOutput
          ? "Provider returned a non-empty output"
          : "Provider returned an empty output",
        durationMs: 0,
      },
    ];
    if (context.node.verification.reviewVerdictRequired) {
      const verdicts = [
        ...context.step.output.matchAll(/(?:^|\n)SUPER_ROUTER_VERDICT:\s*(PASS|FAIL)\s*(?=\n|$)/gu),
      ].map((match) => match[1]);
      const valid = verdicts.length === 1;
      const passed = valid && verdicts[0] === "PASS";
      checks.push({
        name: "semantic-review-verdict",
        passed,
        details: !valid
          ? "Review must return exactly one SUPER_ROUTER_VERDICT: PASS or FAIL line"
          : passed
            ? "Reviewer returned an explicit PASS verdict"
            : "Reviewer returned an explicit FAIL verdict",
        durationMs: 0,
      });
    }
    const artifactPaths = new Set(context.node.expectedArtifact.paths ?? []);
    if (context.node.expectedArtifact.type === "test-report") {
      for (const path of context.step.artifacts) {
        if (path.trim()) artifactPaths.add(path);
      }
      const hasObjectiveEvidence =
        context.node.verification.commands.length > 0 ||
        artifactPaths.size > 0 ||
        context.node.verification.requireIndependentReview ||
        context.node.verification.requireHumanApproval;
      if (!hasObjectiveEvidence) {
        checks.push({
          name: "test-report-evidence",
          passed: false,
          details:
            "A test report requires a verification command, verified artifact, independent review, or human approval",
          durationMs: 0,
        });
      }
    }

    for (const command of context.node.verification.commands) {
      const elapsed = Date.now() - startedAt;
      const remaining = context.timeoutMs - elapsed;
      if (remaining <= 0) {
        checks.push({
          name: command,
          passed: false,
          details: "Verification budget exhausted before command started",
          durationMs: 0,
        });
        break;
      }
      checks.push(await this.#runCommand(command, context.cwd, remaining, context.signal));
    }

    for (const path of artifactPaths) {
      checks.push(await verifyArtifact(path, context.cwd));
    }

    if (context.node.verification.requireIndependentReview) {
      const reviewStarted = Date.now();
      if (!this.#independentReviewer) {
        checks.push({
          name: "independent-review",
          passed: false,
          details: "Independent reviewer is required but not configured",
          durationMs: Date.now() - reviewStarted,
        });
      } else {
        const remaining = context.timeoutMs - (Date.now() - startedAt);
        const bounded = await runBoundedCallback(
          "Independent reviewer",
          this.#independentReviewer,
          context,
          remaining,
        );
        const review = bounded.ok ? bounded.value : undefined;
        const valid =
          review !== undefined &&
          typeof review.passed === "boolean" &&
          typeof review.details === "string";
        checks.push({
          name: "independent-review",
          passed: bounded.ok && valid && review.passed,
          details: bounded.ok
            ? valid
              ? redactText(review.details, { maxStringLength: 8_000 })
              : "Independent reviewer returned an invalid structured verdict"
            : bounded.error,
          durationMs: Date.now() - reviewStarted,
        });
      }
    }

    if (context.node.verification.requireHumanApproval) {
      const approvalStarted = Date.now();
      const remaining = context.timeoutMs - (Date.now() - startedAt);
      const bounded = this.#humanApproval
        ? await runBoundedCallback("Human approval", this.#humanApproval, context, remaining)
        : ({ ok: false, error: "Human approval handler is not configured" } as const);
      const approved = bounded.ok && bounded.value === true;
      checks.push({
        name: "human-approval",
        passed: approved,
        details: approved
          ? "Approved by a human"
          : bounded.ok
            ? "Human approval was denied or returned an invalid response"
            : bounded.error,
        durationMs: Date.now() - approvalStarted,
      });
    }

    // No checks means the provider completed a step that has no objective gate.
    // Preserve that distinction in the reason while allowing the plan to proceed.
    const score =
      checks.length === 0 ? 1 : checks.filter((check) => check.passed).length / checks.length;
    const passed =
      checks.every((check) => check.passed) && score >= context.node.verification.minimumScore;
    return {
      passed,
      score,
      checks,
      reason:
        checks.length === 0
          ? "No verification checks were configured"
          : passed
            ? "All required verification checks passed"
            : `${checks.filter((check) => !check.passed).length} verification check(s) failed`,
    };
  }

  async #runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CheckResult> {
    const startedAt = Date.now();
    let parsed: readonly string[];
    try {
      parsed = parseCommandLine(command);
    } catch (error) {
      return failedCheck(command, error, startedAt);
    }

    const executable = parsed[0];
    if (!executable) return failedCheck(command, new Error("Command is empty"), startedAt);
    const validator = this.#allowlist[executable];
    if (!validator) {
      return failedCheck(
        command,
        new Error(`Executable is not allowlisted: ${executable}`),
        startedAt,
      );
    }
    const validation = validator(parsed.slice(1));
    if (validation !== true) {
      const reason = typeof validation === "string" ? validation : "Arguments are not allowlisted";
      return failedCheck(command, new Error(`${executable}: ${reason}`), startedAt);
    }

    if (this.#policy) {
      const action = {
        kind: classifyAction(command),
        description: `Run verification command: ${command}`,
        source: "verification" as const,
      };
      const decision = await this.#policy.authorize(action);
      if (!decision.allowed) return failedCheck(command, new Error(decision.reason), startedAt);
    }

    try {
      const result = await this.#runner.run({
        executable,
        args: parsed.slice(1),
        cwd,
        timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
        env: this.#environment,
        envMode: "replace",
        ...(signal ? { signal } : {}),
      });
      const details = redactText(
        [result.stdout, result.stderr].filter(Boolean).join("\n").trim() ||
          `Exited with code ${result.exitCode}`,
        { maxStringLength: 12_000 },
      );
      return {
        name: command,
        passed: result.exitCode === 0 && !result.timedOut,
        details,
        durationMs: result.durationMs,
      };
    } catch (error) {
      return failedCheck(command, error, startedAt);
    }
  }
}

type BoundedCallbackResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function runBoundedCallback<T>(
  label: string,
  callback: (context: VerificationContext) => Promise<T>,
  context: VerificationContext,
  timeoutMs: number,
): Promise<BoundedCallbackResult<T>> {
  if (timeoutMs <= 0) return { ok: false, error: `${label} budget was exhausted before it began` };
  if (context.signal?.aborted) return { ok: false, error: `${label} was aborted before it began` };

  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const callbackContext: VerificationContext = {
    ...context,
    timeoutMs,
    signal: controller.signal,
  };

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => callback(callbackContext)),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error(`${label} was aborted`),
            ),
          { once: true },
        );
      }),
    ]);
    return { ok: true, value: result };
  } catch (error) {
    return {
      ok: false,
      error: redactText(error instanceof Error ? error.message : String(error), {
        maxStringLength: 8_000,
      }),
    };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abortFromParent);
  }
}

export function parseCommandLine(command: string): readonly string[] {
  if (!command.trim()) throw new Error("Command is empty");
  if (/[\n\r;&|<>`]/.test(command) || /\$[({]/.test(command)) {
    throw new Error("Shell operators, substitutions, and redirections are not allowed");
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) throw new Error("Command contains an unfinished escape or quote");
  if (current) args.push(current);
  if (!args[0] || isAbsolute(args[0]) || args[0].includes("/") || args[0].includes("\\")) {
    throw new Error("Executable must be a bare allowlisted command name");
  }
  return args;
}

function normalizeAllowlist(
  allowlist: SafeVerificationRunnerOptions["allowlist"],
): Readonly<Record<string, CommandValidator>> {
  if (!allowlist) return DEFAULT_ALLOWLIST;
  if (Array.isArray(allowlist)) {
    return Object.fromEntries(allowlist.map((executable) => [executable, () => true]));
  }
  return allowlist as Readonly<Record<string, CommandValidator>>;
}

function validatePackageRunner(args: readonly string[]): boolean | string {
  const [command, script] = args;
  if (command === "test") return true;
  if (command === "run" && script && SAFE_SCRIPT_NAMES.has(script)) return true;
  // Yarn commonly omits the `run` subcommand.
  if (command && SAFE_SCRIPT_NAMES.has(command)) return true;
  return "only test, build, check, lint, and typecheck scripts are allowed";
}

async function verifyArtifact(path: string, cwd: string): Promise<CheckResult> {
  const startedAt = Date.now();
  if (!path.trim()) {
    return failedCheck("artifact:<empty>", new Error("Artifact path is empty"), startedAt);
  }
  try {
    const canonicalWorkspace = await realpath(cwd);
    const resolved = resolve(canonicalWorkspace, path);
    if (!isContained(canonicalWorkspace, resolved)) {
      return failedCheck(
        `artifact:${path}`,
        new Error("Artifact path escapes the workspace"),
        startedAt,
      );
    }
    const linkMetadata = await lstat(resolved);
    const canonicalArtifact = await realpath(resolved);
    if (!isContained(canonicalWorkspace, canonicalArtifact)) {
      return failedCheck(
        `artifact:${path}`,
        new Error("Artifact symlink resolves outside the workspace"),
        startedAt,
      );
    }
    const metadata = await stat(canonicalArtifact);
    return {
      name: `artifact:${path}`,
      passed: metadata.isFile() || metadata.isDirectory(),
      details: `${linkMetadata.isSymbolicLink() ? "Contained symlink to " : ""}${
        metadata.isDirectory() ? "directory" : "file"
      } exists inside the workspace`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return failedCheck(`artifact:${path}`, error, startedAt);
  }
}

export function minimalVerificationEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const allowedKeys = [
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ];
  const environment: Record<string, string> = {
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  for (const key of allowedKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function failedCheck(name: string, error: unknown, startedAt: number): CheckResult {
  return {
    name,
    passed: false,
    details: redactText(error instanceof Error ? error.message : String(error), {
      maxStringLength: 8_000,
    }),
    durationMs: Date.now() - startedAt,
  };
}
