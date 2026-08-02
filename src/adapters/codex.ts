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
import { asNumber, asRecord, asString, emptyUsage, ProviderExecutionError } from "./shared.ts";

export interface CodexAdapterOptions {
  executable?: string;
  runner?: ProcessRunner;
  models?: readonly ModelCapability[];
  maxOutputBytes?: number;
  meteredBilling?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  sandbox?: "read-only" | "workspace-write";
  buildArgs?: (context: ExecutionContext) => readonly string[];
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly #executable: string;
  readonly #runner: ProcessRunner;
  readonly #models: readonly ModelCapability[];
  readonly #maxOutputBytes: number;
  readonly #sandbox: "read-only" | "workspace-write" | undefined;
  readonly #buildArgs: ((context: ExecutionContext) => readonly string[]) | undefined;
  readonly #meteredBilling: boolean;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #availabilityEnvironment: Readonly<Record<string, string>>;

  constructor(options: CodexAdapterOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#runner = options.runner ?? new SpawnProcessRunner();
    this.#models = options.models ?? [];
    this.#maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    this.#sandbox = options.sandbox;
    this.#buildArgs = options.buildArgs;
    this.#meteredBilling = options.meteredBilling ?? true;
    this.#environment = providerProcessEnvironment(
      "codex",
      this.#meteredBilling ? "metered" : "subscription",
      options.environment ?? process.env,
    );
    this.#availabilityEnvironment = providerProcessEnvironment(
      "codex",
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
        env: {
          ...this.#availabilityEnvironment,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "super-router",
        },
        timeoutMs: 3_000,
        maxOutputBytes: 64 * 1024,
      });
      installed = version.exitCode === 0;
    } catch {
      return { installed: false, authenticated: false, available: false };
    }
    if (!installed) return { installed: false, authenticated: false, available: false };
    if (this.#meteredBilling) {
      const authenticated = Boolean(
        this.#environment.OPENAI_API_KEY || this.#environment.CODEX_API_KEY,
      );
      return { installed, authenticated, available: authenticated };
    }
    try {
      const auth = await this.#runner.run({
        executable: this.#executable,
        args: ["login", "status"],
        cwd: process.cwd(),
        envMode: "replace",
        env: {
          ...this.#environment,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "super-router",
        },
        timeoutMs: 3_000,
        maxOutputBytes: 64 * 1024,
      });
      const authenticated = auth.exitCode === 0;
      return { installed, authenticated, available: authenticated };
    } catch {
      return { installed, authenticated: false, available: false };
    }
  }

  async execute(context: ExecutionContext): Promise<ProviderExecutionResult> {
    if (context.route.tools.some((tool) => tool === "Agent" || tool === "Skill")) {
      throw new Error("Codex native Agent and Skill tools are disabled");
    }
    if (
      (context.route.agent || context.route.skills.length > 0) &&
      (!materializationCoversRoute(context.materializedCapabilities, context.route) ||
        !promptContainsMaterialization(context.prompt, context.materializedCapabilities))
    ) {
      throw new Error("Codex requires selected capabilities to be materialized in the prompt");
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
    const args = this.#buildArgs?.(context) ?? defaultCodexArgs(context, this.#sandbox);
    const result = await this.#runner.run({
      executable: this.#executable,
      args,
      cwd: context.cwd,
      input: context.prompt,
      timeoutMs: context.timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      envMode: "replace",
      env: { ...this.#environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "super-router" },
      ...(signal ? { signal } : {}),
    });
    const events = parseJsonLinesIfPossible(result.stdout);
    if (result.exitCode !== 0) {
      const usage = finalizeCodexUsage(
        extractCodexUsage(events, result.durationMs),
        context,
        this.#models,
        this.#meteredBilling,
      );
      if (hasUsage(usage)) {
        throw new ProviderExecutionError(
          `Codex exited with code ${result.exitCode}: ${redactText(result.stderr, { maxStringLength: 2_000 })}`,
          usage,
        );
      }
      throw new ProcessExecutionError(
        `Codex exited with code ${result.exitCode}: ${redactText(result.stderr, { maxStringLength: 2_000 })}`,
        result,
      );
    }

    if (events.length === 0 && result.stdout.trim()) parseJsonLines(result.stdout);
    const output = extractLastAgentMessage(events);
    const reportedUsage = extractCodexUsage(events, result.durationMs);
    const usage = finalizeCodexUsage(reportedUsage, context, this.#models, this.#meteredBilling);
    return { output, artifacts: extractArtifacts(events), usage, raw: events };
  }
}

function finalizeCodexUsage(
  usage: UsageRecord,
  context: ExecutionContext,
  models: readonly ModelCapability[],
  meteredBilling: boolean,
): UsageRecord {
  if (!meteredBilling) return { ...usage, costUsd: 0, costFinal: true };
  return withCalculatedCost(usage, context.route, [...models]);
}

function parseJsonLinesIfPossible(value: string): Record<string, unknown>[] {
  if (!value.trim()) return [];
  try {
    return parseJsonLines(value);
  } catch {
    return [];
  }
}

function hasUsage(usage: UsageRecord): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.costUsd > 0
  );
}

function defaultCodexArgs(
  context: ExecutionContext,
  configuredSandbox?: "read-only" | "workspace-write",
): readonly string[] {
  const routeCanWrite = context.route.tools.some((tool) =>
    ["edit", "write"].includes(tool.toLocaleLowerCase("en-US")),
  );
  const sandbox = configuredSandbox ?? (routeCanWrite ? "workspace-write" : "read-only");
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--model",
    context.route.model,
    "--sandbox",
    sandbox,
    "-c",
    `model_reasoning_effort=${JSON.stringify(codexEffort(context.route.effort))}`,
    "-",
  ];
}

function codexEffort(effort: EffortLevel): string {
  switch (effort) {
    case "economy":
      return "low";
    case "balanced":
      return "medium";
    case "deep":
      return "high";
    case "max":
      return "xhigh";
  }
}

function parseJsonLines(value: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const event = asRecord(parsed);
      if (event) events.push(event);
    } catch (error) {
      throw new Error(
        `Codex returned invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

function extractLastAgentMessage(events: readonly Record<string, unknown>[]): string {
  let output = "";
  for (const event of events) {
    const item = asRecord(event.item);
    if (event.type === "item.completed" && item?.type === "agent_message") {
      output = asString(item.text) ?? output;
    }
    if (event.type === "agent_message") output = asString(event.message ?? event.text) ?? output;
  }
  return output;
}

function extractCodexUsage(
  events: readonly Record<string, unknown>[],
  durationMs: number,
): UsageRecord {
  let usage = emptyUsage(durationMs);
  for (const event of events) {
    const direct = asRecord(event.usage);
    const payload = asRecord(event.payload);
    const info = asRecord(payload?.info);
    const nested = asRecord(info?.total_token_usage);
    const candidate = direct ?? nested;
    if (!candidate) continue;
    usage = {
      inputTokens: asNumber(candidate.input_tokens),
      outputTokens: asNumber(candidate.output_tokens),
      reasoningTokens: asNumber(candidate.reasoning_tokens ?? candidate.reasoning_output_tokens),
      cachedInputTokens: asNumber(candidate.cached_input_tokens),
      costUsd: asNumber(candidate.cost_usd),
      durationMs,
    };
  }
  return usage;
}

function extractArtifacts(events: readonly Record<string, unknown>[]): string[] {
  const artifacts = new Set<string>();
  for (const event of events) {
    const item = asRecord(event.item);
    const changes = item?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const path = asString(asRecord(change)?.path);
      if (path) artifacts.add(path);
    }
  }
  return [...artifacts];
}
