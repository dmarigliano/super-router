import { describe, expect, test } from "bun:test";
import type { ModelCapability, RouteDecision, UsageRecord } from "../src/contracts.ts";
import { withCalculatedCost } from "../src/telemetry/cost.ts";

const route: RouteDecision = {
  provider: "metered",
  model: "model",
  effort: "balanced",
  skills: [],
  tools: [],
  expectedQuality: 0.9,
  expectedCostUsd: 0.25,
  expectedLatencyMs: 1,
  reason: "test",
};

const model: ModelCapability = {
  provider: "metered",
  model: "model",
  displayName: "Metered model",
  taskTypes: ["research"],
  domains: ["general"],
  supportedEfforts: ["balanced"],
  tools: [],
  contextWindow: 100_000,
  maxOutputTokens: 10_000,
  inputCostPerMillion: 2,
  outputCostPerMillion: 8,
  qualityPrior: 0.9,
  latencyPriorMs: 1,
  enabled: true,
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    durationMs: 1,
    ...overrides,
  };
}

describe("conservative metered cost finalization", () => {
  test("keeps missing provider usage non-final so the scheduler can charge its reservation", () => {
    expect(withCalculatedCost(usage(), route, [model])).toMatchObject({
      costUsd: 0,
      costFinal: false,
    });
  });

  test("finalizes calculated cost only when billable usage was reported", () => {
    const result = withCalculatedCost(usage({ inputTokens: 1_000, outputTokens: 500 }), route, [
      model,
    ]);
    expect(result.costFinal).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});
