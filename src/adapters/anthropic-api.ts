import type {
  EffortLevel,
  ExecutionContext,
  ModelCapability,
  ProviderAdapter,
  ProviderAvailability,
  ProviderExecutionResult,
  UsageRecord,
} from "../contracts.ts";
import { withCalculatedCost } from "../telemetry/cost.ts";
import { executionSignal } from "./execution-context.ts";
import {
  assertTextOnlyExecution,
  type FetchLike,
  HttpJsonClient,
  HttpProviderError,
  normalizeApiBaseUrl,
  redactKnownSecrets,
  redactProviderValue,
  resolveApiKey,
} from "./http-client.ts";
import { asNumber, asRecord, asString } from "./shared.ts";

export interface AnthropicApiAdapterOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  anthropicVersion?: string;
  fetch?: FetchLike;
  maxResponseBytes?: number;
  models?: readonly ModelCapability[];
  includeEffort?: boolean;
}

/** Non-streaming, text-only adapter for Anthropic's official Messages API. */
export class AnthropicApiAdapter implements ProviderAdapter {
  readonly id = "anthropic-api";
  readonly #explicitApiKey: string | undefined;
  readonly #apiKeyEnv: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #endpoint: string;
  readonly #anthropicVersion: string;
  readonly #http: HttpJsonClient;
  readonly #models: readonly ModelCapability[];
  readonly #includeEffort: boolean;

  constructor(options: AnthropicApiAdapterOptions = {}) {
    this.#explicitApiKey = options.apiKey;
    this.#apiKeyEnv = options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    this.#environment = options.environment ?? process.env;
    this.#endpoint = `${normalizeApiBaseUrl(options.baseUrl ?? "https://api.anthropic.com")}/v1/messages`;
    this.#anthropicVersion = options.anthropicVersion ?? "2023-06-01";
    this.#http = new HttpJsonClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    });
    this.#models = options.models ?? [];
    this.#includeEffort = options.includeEffort ?? true;
    // Validate the configured environment name without requiring a key.
    resolveApiKey(undefined, {}, this.#apiKeyEnv);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    const authenticated = Boolean(this.#apiKey());
    return { installed: true, authenticated, available: authenticated };
  }

  async execute(context: ExecutionContext): Promise<ProviderExecutionResult> {
    assertTextOnlyExecution(context, this.id);
    const apiKey = this.#apiKey();
    if (!apiKey) {
      throw new HttpProviderError(
        `${this.id} is unavailable because ${this.#apiKeyEnv} is not configured`,
      );
    }
    const outputBudget = positiveInteger(context.step.outputBudget, "step.outputBudget");
    const body = {
      model: context.route.model,
      max_tokens: outputBudget,
      messages: [{ role: "user", content: context.prompt }],
      stream: false,
      ...(this.#includeEffort
        ? { output_config: { effort: anthropicEffort(context.route.effort) } }
        : {}),
    };
    const signal = executionSignal(context);
    const response = await this.#http.postJson(this.#endpoint, body, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": this.#anthropicVersion,
      },
      timeoutMs: context.timeoutMs,
      secrets: [apiKey],
      ...(signal ? { signal } : {}),
    });

    const record = asRecord(response.data);
    if (!record) throw new HttpProviderError("Anthropic returned a non-object response");
    throwAnthropicResponseError(record, apiKey);
    const output = extractAnthropicText(record, apiKey);
    const usage = withCalculatedCost(
      parseAnthropicUsage(record, response.durationMs),
      context.route,
      [...this.#models],
    );
    return {
      output,
      artifacts: [],
      usage,
      raw: redactProviderValue(response.data, [apiKey]),
    };
  }

  #apiKey(): string | undefined {
    return resolveApiKey(this.#explicitApiKey, this.#environment, this.#apiKeyEnv);
  }
}

function anthropicEffort(effort: EffortLevel): "low" | "medium" | "high" | "max" {
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

function throwAnthropicResponseError(record: Record<string, unknown>, apiKey: string): void {
  if (record.type === "error" || record.error !== undefined) {
    const error = asRecord(record.error);
    const detail = asString(error?.message) ?? asString(record.error) ?? "Anthropic request failed";
    throw new HttpProviderError(redactKnownSecrets(detail, [apiKey], 2_000));
  }
  const stopReason = asString(record.stop_reason);
  if (
    ["max_tokens", "model_context_window_exceeded", "pause_turn", "tool_use"].includes(
      stopReason ?? "",
    )
  ) {
    throw new HttpProviderError(`Anthropic response stopped before completion: ${stopReason}`);
  }
}

function extractAnthropicText(record: Record<string, unknown>, apiKey: string): string {
  if (!Array.isArray(record.content)) {
    throw new HttpProviderError("Anthropic response is missing content blocks");
  }
  if (record.content.some((block) => asRecord(block)?.type === "tool_use")) {
    throw new HttpProviderError(
      "Anthropic returned a tool request even though no tools were supplied",
    );
  }
  const output = record.content
    .flatMap((block) => {
      const content = asRecord(block);
      return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
    })
    .join("\n")
    .trim();
  if (!output) throw new HttpProviderError("Anthropic response contained no text output");
  return redactKnownSecrets(output, [apiKey]);
}

function parseAnthropicUsage(record: Record<string, unknown>, durationMs: number): UsageRecord {
  const usage = asRecord(record.usage) ?? {};
  const uncachedInput = asNumber(usage.input_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  return {
    inputTokens: uncachedInput + cacheRead + cacheCreation,
    outputTokens: asNumber(usage.output_tokens),
    reasoningTokens: 0,
    cachedInputTokens: cacheRead,
    costUsd: 0,
    durationMs,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return Math.max(1, Math.floor(value));
}
