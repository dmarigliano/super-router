import type {
  EffortLevel,
  ExecutionContext,
  ModelCapability,
  ProviderAdapter,
  ProviderAvailability,
  ProviderExecutionResult,
  UsageRecord,
} from "../contracts.ts";
import {
  materializationCoversRoute,
  promptContainsMaterialization,
} from "../routing/capability-materialization.ts";
import { redactText } from "../security/redaction.ts";
import { withCalculatedCost } from "../telemetry/cost.ts";
import { executionSignal } from "./execution-context.ts";
import type { ProcessRunner } from "./process-runner.ts";
import { ProcessExecutionError, SpawnProcessRunner } from "./process-runner.ts";
import { providerProcessEnvironment } from "./provider-environment.ts";
import {
  asNumber,
  asRecord,
  asString,
  emptyUsage,
  ProviderExecutionError,
  parseJson,
} from "./shared.ts";

export interface ClaudeCodeAdapterOptions {
  executable?: string;
  runner?: ProcessRunner;
  models?: readonly ModelCapability[];
  maxOutputBytes?: number;
  meteredBilling?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  buildArgs?: (context: ExecutionContext) => readonly string[];
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = "claude-code";
  readonly #executable: string;
  readonly #runner: ProcessRunner;
  readonly #models: readonly ModelCapability[];
  readonly #maxOutputBytes: number;
  readonly #buildArgs: (context: ExecutionContext) => readonly string[];
  readonly #meteredBilling: boolean;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #availabilityEnvironment: Readonly<Record<string, string>>;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#executable = options.executable ?? "claude";
    this.#runner = options.runner ?? new SpawnProcessRunner();
    this.#models = options.models ?? [];
    this.#maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    this.#buildArgs = options.buildArgs ?? defaultClaudeArgs;
    this.#meteredBilling = options.meteredBilling ?? true;
    this.#environment = providerProcessEnvironment(
      "claude-code",
      this.#meteredBilling ? "metered" : "subscription",
      options.environment ?? process.env,
    );
    this.#availabilityEnvironment = providerProcessEnvironment(
      "claude-code",
      this.#meteredBilling ? "metered" : "subscription",
      options.environment ?? process.env,
      false,
    );
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    let installed = false;
    try {
      const version = await this.#runner.run({
        executable: this.#executable,
        args: ["--version"],
        cwd: process.cwd(),
        envMode: "replace",
        env: { ...this.#availabilityEnvironment, CLAUDE_CODE_ENTRYPOINT: "super-router" },
        timeoutMs: 3_000,
        maxOutputBytes: 64 * 1024,
      });
      installed = version.exitCode === 0;
    } catch {
      return { installed: false, authenticated: false, available: false };
    }
    if (!installed) return { installed: false, authenticated: false, available: false };
    if (this.#meteredBilling) {
      const authenticated = Boolean(this.#environment.ANTHROPIC_API_KEY);
      return { installed, authenticated, available: authenticated };
    }
    try {
      const auth = await this.#runner.run({
        executable: this.#executable,
        args: ["auth", "status", "--json"],
        cwd: process.cwd(),
        envMode: "replace",
        env: { ...this.#environment, CLAUDE_CODE_ENTRYPOINT: "super-router" },
        timeoutMs: 3_000,
        maxOutputBytes: 64 * 1024,
      });
      const status = asRecord(parseJson(auth.stdout));
      const authenticated = auth.exitCode === 0 && status?.loggedIn === true;
      return { installed, authenticated, available: authenticated };
    } catch {
      return { installed, authenticated: false, available: false };
    }
  }

  async execute(context: ExecutionContext): Promise<ProviderExecutionResult> {
    if (context.route.tools.some((tool) => tool === "Agent" || tool === "Skill")) {
      throw new Error("Claude Code native Agent and Skill tools are disabled");
    }
    if (
      (context.route.agent || context.route.skills.length > 0) &&
      (!materializationCoversRoute(context.materializedCapabilities, context.route) ||
        !promptContainsMaterialization(context.prompt, context.materializedCapabilities))
    ) {
      throw new Error(
        "Claude Code requires selected capabilities to be materialized in the prompt",
      );
    }
    try {
      return await this.#executeOnce(context);
    } catch (error) {
      if (this.#meteredBilling || error instanceof ProviderExecutionError) throw error;
      const durationMs = error instanceof ProcessExecutionError ? error.result.durationMs : 0;
      throw new ProviderExecutionError(error instanceof Error ? error.message : String(error), {
        ...emptyUsage(durationMs),
        costFinal: true,
      });
    }
  }

  async #executeOnce(context: ExecutionContext): Promise<ProviderExecutionResult> {
    const signal = executionSignal(context);
    const result = await this.#runner.run({
      executable: this.#executable,
      args: this.#buildArgs(context),
      cwd: context.cwd,
      input: context.prompt,
      timeoutMs: context.timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      envMode: "replace",
      env: { ...this.#environment, CLAUDE_CODE_ENTRYPOINT: "super-router" },
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      throw new ProcessExecutionError(
        `Claude Code exited with code ${result.exitCode}: ${redactText(result.stderr, { maxStringLength: 2_000 })}`,
        result,
      );
    }

    const raw = parseJson(result.stdout);
    const record = asRecord(raw);
    if (!record) throw new Error("Claude Code returned a non-object response");
    if (record.is_error === true || record.subtype === "error") {
      const usage = finalizeClaudeUsage(
        parseClaudeUsage(record, result.durationMs),
        context,
        this.#models,
        this.#meteredBilling,
      );
      throw new ProviderExecutionError(
        redactText(asString(record.result) ?? asString(record.error) ?? "Claude Code failed", {
          maxStringLength: 2_000,
        }),
        usage,
      );
    }

    const reportedUsage = parseClaudeUsage(record, result.durationMs);
    const usage = finalizeClaudeUsage(reportedUsage, context, this.#models, this.#meteredBilling);
    return {
      output: asString(record.result) ?? asString(record.output) ?? "",
      artifacts: parseArtifacts(record.artifacts),
      usage,
      raw,
    };
  }
}

function finalizeClaudeUsage(
  usage: UsageRecord,
  context: ExecutionContext,
  models: readonly ModelCapability[],
  meteredBilling: boolean,
): UsageRecord {
  if (!meteredBilling) return { ...usage, costUsd: 0, costFinal: true };
  return withCalculatedCost(usage, context.route, [...models]);
}

function defaultClaudeArgs(context: ExecutionContext): readonly string[] {
  const safeTools = context.route.tools.filter(
    (tool) =>
      ["Agent", "Edit", "Glob", "Grep", "Read", "Skill", "Write"].includes(tool) &&
      tool !== "Agent" &&
      tool !== "Skill",
  );
  const args = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--no-chrome",
    "--tools",
    safeTools.join(","),
    "--model",
    context.route.model,
    "--effort",
    claudeEffort(context.route.effort),
    "--max-turns",
    String(maxTurns(context.route.effort)),
    "--max-budget-usd",
    String(context.costCeilingUsd),
    "--permission-mode",
    context.route.tools.some((tool) => tool === "Edit" || tool === "Write")
      ? "acceptEdits"
      : "plan",
  ];
  args.push("--safe-mode");
  if (safeTools.length > 0) args.push("--allowedTools", ...safeTools);
  return args;
}

function claudeEffort(effort: EffortLevel): string {
  switch (effort) {
    case "economy":
      return "low";
    case "balanced":
      return "medium";
    case "deep":
      return "high";
    case "max":
      return "max";
  }
}

function maxTurns(effort: EffortLevel): number {
  switch (effort) {
    case "economy":
      return 6;
    case "balanced":
      return 12;
    case "deep":
      return 20;
    case "max":
      return 32;
  }
}

function parseClaudeUsage(record: Record<string, unknown>, durationMs: number): UsageRecord {
  const usage = asRecord(record.usage) ?? {};
  const cached = asNumber(usage.cache_read_input_tokens ?? usage.cached_input_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  const uncached = asNumber(usage.input_tokens);
  return {
    inputTokens: uncached + cached + cacheCreation,
    outputTokens: asNumber(usage.output_tokens),
    reasoningTokens: asNumber(usage.thinking_tokens ?? usage.reasoning_tokens),
    cachedInputTokens: cached,
    costUsd: asNumber(record.total_cost_usd ?? usage.cost_usd),
    durationMs: asNumber(record.duration_ms) || durationMs,
  };
}

function parseArtifacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const path = asString(asRecord(item)?.path);
    return path ? [path] : [];
  });
}
