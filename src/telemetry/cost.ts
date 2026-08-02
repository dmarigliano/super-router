import type { ModelCapability, RouteDecision, UsageRecord } from "../contracts.ts";

export interface CostBreakdown {
  uncachedInputUsd: number;
  cachedInputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export function calculateUsageCost(
  usage: UsageRecord,
  pricing: Pick<
    ModelCapability,
    "inputCostPerMillion" | "outputCostPerMillion" | "cachedInputCostPerMillion"
  >,
): CostBreakdown {
  const cachedInputTokens = clampTokenCount(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const cachedRate = pricing.cachedInputCostPerMillion ?? pricing.inputCostPerMillion;
  const uncachedInputUsd = (uncachedInputTokens / 1_000_000) * pricing.inputCostPerMillion;
  const cachedInputUsd = (cachedInputTokens / 1_000_000) * cachedRate;
  // Providers differ on whether reasoning is reported as a subset of output.
  // The shared contract treats outputTokens as the billable total to prevent
  // double charging reasoning tokens.
  const outputUsd = (Math.max(0, usage.outputTokens) / 1_000_000) * pricing.outputCostPerMillion;
  return {
    uncachedInputUsd,
    cachedInputUsd,
    outputUsd,
    totalUsd: roundUsd(uncachedInputUsd + cachedInputUsd + outputUsd),
  };
}

export function findPricing(
  route: RouteDecision,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return models.find((model) => model.provider === route.provider && model.model === route.model);
}

export function withCalculatedCost(
  usage: UsageRecord,
  route: RouteDecision,
  models: readonly ModelCapability[],
): UsageRecord {
  if (usage.costFinal === true) return usage;
  if (usage.costUsd > 0) return { ...usage, costFinal: true };
  const pricing = findPricing(route, models);
  if (!pricing) return { ...usage, costFinal: false };
  // A metered response without billable token usage is not proof of zero cost.
  // Keep it non-final so the scheduler retains its conservative reservation.
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) {
    return { ...usage, costUsd: 0, costFinal: false };
  }
  return {
    ...usage,
    costUsd: calculateUsageCost(usage, pricing).totalUsd,
    costFinal: true,
  };
}

function clampTokenCount(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Math.max(0, Math.floor(maximum)));
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
