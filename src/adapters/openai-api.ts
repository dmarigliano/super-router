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

export interface OpenAIApiAdapterOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  fetch?: FetchLike;
  maxResponseBytes?: number;
  models?: readonly ModelCapability[];
  includeReasoningEffort?: boolean;
}

/** Non-streaming, text-only adapter for OpenAI's official Responses API. */
export class OpenAIApiAdapter implements ProviderAdapter {
  readonly id = "openai-api";
  readonly #explicitApiKey: string | undefined;
  readonly #apiKeyEnv: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #endpoint: string;
  readonly #http: HttpJsonClient;
  readonly #models: readonly ModelCapability[];
  readonly #includeReasoningEffort: boolean;

  constructor(options: OpenAIApiAdapterOptions = {}) {
    this.#explicitApiKey = options.apiKey;
    this.#apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
    this.#environment = options.environment ?? process.env;
    this.#endpoint = `${normalizeApiBaseUrl(options.baseUrl ?? "https://api.openai.com")}/v1/responses`;
    this.#http = new HttpJsonClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    });
    this.#models = options.models ?? [];
    this.#includeReasoningEffort = options.includeReasoningEffort ?? true;
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
    const body = {
      model: context.route.model,
      input: context.prompt,
      max_output_tokens: positiveInteger(context.step.outputBudget, "step.outputBudget"),
      store: false,
      stream: false,
      ...(this.#includeReasoningEffort
        ? { reasoning: { effort: openAiEffort(context.route.effort) } }
        : {}),
    };
    const signal = executionSignal(context);
    const response = await this.#http.postJson(this.#endpoint, body, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: context.timeoutMs,
      secrets: [apiKey],
      ...(signal ? { signal } : {}),
    });

    const record = asRecord(response.data);
    if (!record) throw new HttpProviderError("OpenAI returned a non-object response");
    throwOpenAiResponseError(record, apiKey);
    const output = extractOpenAiText(record, apiKey);
    const usage = withCalculatedCost(parseOpenAiUsage(record, response.durationMs), context.route, [
      ...this.#models,
    ]);
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

function openAiEffort(effort: EffortLevel): "low" | "medium" | "high" | "xhigh" {
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

function throwOpenAiResponseError(record: Record<string, unknown>, apiKey: string): void {
  const error = asRecord(record.error);
  if (error || record.status === "failed" || record.status === "cancelled") {
    const detail =
      asString(error?.message) ?? asString(record.error) ?? `status ${String(record.status)}`;
    throw new HttpProviderError(
      redactKnownSecrets(`OpenAI response failed: ${detail}`, [apiKey], 2_000),
    );
  }
  if (record.status === "incomplete") {
    const details = asRecord(record.incomplete_details);
    throw new HttpProviderError(
      `OpenAI response was incomplete: ${asString(details?.reason) ?? "unknown reason"}`,
    );
  }
}

function extractOpenAiText(record: Record<string, unknown>, apiKey: string): string {
  const direct = asString(record.output_text);
  if (direct?.trim()) return redactKnownSecrets(direct.trim(), [apiKey]);
  if (!Array.isArray(record.output))
    throw new HttpProviderError("OpenAI response is missing output items");

  const text: string[] = [];
  for (const itemValue of record.output) {
    const item = asRecord(itemValue);
    if (!item) continue;
    if (
      ["function_call", "custom_tool_call", "web_search_call", "file_search_call"].includes(
        asString(item.type) ?? "",
      )
    ) {
      throw new HttpProviderError("OpenAI returned a tool call even though no tools were supplied");
    }
    if (!Array.isArray(item.content)) continue;
    for (const blockValue of item.content) {
      const block = asRecord(blockValue);
      if (!block) continue;
      if (block.type === "output_text" && typeof block.text === "string") text.push(block.text);
      if (block.type === "refusal") {
        const refusal =
          typeof block.refusal === "string" ? block.refusal : "provider safety refusal";
        throw new HttpProviderError(
          redactKnownSecrets(`OpenAI refused the request: ${refusal}`, [apiKey], 2_000),
        );
      }
    }
  }
  const output = text.join("\n").trim();
  if (!output) throw new HttpProviderError("OpenAI response contained no text output");
  return redactKnownSecrets(output, [apiKey]);
}

function parseOpenAiUsage(record: Record<string, unknown>, durationMs: number): UsageRecord {
  const usage = asRecord(record.usage) ?? {};
  const inputDetails = asRecord(usage.input_tokens_details) ?? {};
  const outputDetails = asRecord(usage.output_tokens_details) ?? {};
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    reasoningTokens: asNumber(outputDetails.reasoning_tokens),
    cachedInputTokens: asNumber(inputDetails.cached_tokens),
    costUsd: 0,
    durationMs,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return Math.max(1, Math.floor(value));
}
