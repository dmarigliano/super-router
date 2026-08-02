import type { RouteDecision, UsageRecord } from "../contracts.ts";

export class ProviderExecutionError extends Error {
  readonly usage: UsageRecord;

  constructor(message: string, usage: UsageRecord) {
    super(message);
    this.name = "ProviderExecutionError";
    this.usage = usage;
  }
}

export function emptyUsage(durationMs = 0): UsageRecord {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    durationMs,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function routeDescription(route: RouteDecision): string {
  return `${route.provider}/${route.model} (${route.effort})`;
}
