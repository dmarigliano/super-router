import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import type {
  AgentCapability,
  CapabilitySnapshot,
  ModelCapability,
  RouteRequest,
  RouterConfig,
  SkillCapability,
} from "../src/contracts.ts";
import { createTaskSpec } from "../src/intake/task-spec.ts";
import { decomposeTask } from "../src/planning/decomposer.ts";
import {
  MAX_AUTOMATIC_SKILL_COMBINATIONS,
  optimizeRoute,
  routeExecutionPlan,
  selectRoute,
} from "../src/routing/optimizer.ts";

const allTools = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Network", "Agent", "Skill"];

function model(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    provider: "test-provider",
    model: "balanced-model",
    displayName: "Balanced model",
    taskTypes: [
      "implement",
      "fix",
      "review",
      "research",
      "design",
      "refactor",
      "test",
      "document",
      "optimize",
      "security-audit",
      "debug",
    ],
    domains: ["general"],
    supportedEfforts: ["balanced"],
    tools: allTools,
    contextWindow: 200_000,
    maxOutputTokens: 50_000,
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    qualityPrior: 0.9,
    latencyPriorMs: 1_000,
    enabled: true,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentCapability> = {}): AgentCapability {
  return {
    id: "backend-specialist",
    description: "Backend specialist",
    instructionCharacters: 128,
    taskTypes: ["implement"],
    domains: ["backend"],
    tools: ["Read", "Edit"],
    skills: [],
    riskCeiling: "critical",
    contextOverheadTokens: 1_000,
    enabled: true,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillCapability> = {}): SkillCapability {
  return {
    id: "backend-patterns",
    description: "Backend patterns",
    instructionCharacters: 128,
    taskTypes: ["implement"],
    domains: ["backend"],
    requiredTools: ["Read"],
    contextOverheadTokens: 500,
    trusted: true,
    enabled: true,
    ...overrides,
  };
}

function config(models: ModelCapability[], overrides: Partial<RouterConfig> = {}): RouterConfig {
  const base = structuredClone(defaultConfig);
  return {
    ...base,
    profile: "balanced",
    qualityFloor: 0.88,
    budget: { ...base.budget, maxCostUsd: 10, maxAttempts: 3 },
    providers: [
      {
        id: "test-provider",
        enabled: true,
        transport: "cli",
        billingMode: "subscription",
        executable: "test-provider",
        defaultModel: models[0]?.model ?? "missing",
        models,
      },
    ],
    ...overrides,
  };
}

function snapshot(
  models: ModelCapability[],
  agents: AgentCapability[] = [],
  skills: SkillCapability[] = [],
): CapabilitySnapshot {
  return {
    models,
    agents,
    skills,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    stepId: "step-1",
    taskIntent: "implement",
    domains: ["backend"],
    riskLevel: "low",
    qualityFloor: 0.88,
    expectedInputTokens: 4_000,
    expectedOutputTokens: 1_000,
    requiredTools: ["Read", "Edit"],
    ...overrides,
  };
}

describe("least-cost quality-gated routing", () => {
  test("selects the cheapest route that clears quality rather than the highest-quality model", () => {
    const economical = model({ model: "economical", qualityPrior: 0.9 });
    const premium = model({
      model: "premium",
      displayName: "Premium",
      qualityPrior: 0.98,
      inputCostPerMillion: 20,
      outputCostPerMillion: 80,
    });
    const routerConfig = config([economical, premium]);
    const result = optimizeRoute(
      request(),
      snapshot([economical, premium], [agent()], [skill()]),
      routerConfig,
    );

    expect(result.primary.model).toBe("economical");
    expect(result.primary.agent).toBeUndefined();
    expect(result.primary.skills).toEqual([]);
    expect(result.primary.reason).toContain(
      "Lowest predicted primary-call cost in the bounded candidate space",
    );
    expect(result.primary.expectedQuality).toBeGreaterThanOrEqual(result.effectiveQualityFloor);
    expect(
      result.considered.some(
        ({ decision, qualifies }) => decision.model === "premium" && qualifies,
      ),
    ).toBe(true);
  });

  test("minimizes predicted tokens when subscription routes have equal monetary cost", () => {
    const subscription = model({
      model: "subscription",
      supportedEfforts: ["economy", "balanced"],
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      qualityPrior: 0.9,
      latencyPriorMs: 10_000,
    });
    const expensiveContextAgent = agent({
      id: "large-context-agent",
      contextOverheadTokens: 50_000,
    });
    const result = optimizeRoute(
      request(),
      snapshot([subscription], [expensiveContextAgent]),
      config([subscription]),
    );

    expect(result.primary.effort).toBe("balanced");
    expect(result.primary.agent).toBeUndefined();
    const selected = result.considered.find(
      ({ decision }) =>
        decision.effort === result.primary.effort && decision.agent === result.primary.agent,
    );
    const economyWithAgent = result.considered.find(
      ({ decision }) => decision.effort === "economy" && decision.agent === "large-context-agent",
    );
    expect(economyWithAgent?.qualifies).toBe(true);
    expect(
      (selected?.estimatedInputTokens ?? 0) + (selected?.estimatedOutputTokens ?? 0),
    ).toBeLessThan(
      (economyWithAgent?.estimatedInputTokens ?? 0) +
        (economyWithAgent?.estimatedOutputTokens ?? 0),
    );
  });

  test("uses a trusted skill only when its quality boost is required", () => {
    const borderline = model({
      model: "borderline",
      domains: ["general"],
      qualityPrior: 0.895,
    });
    const trusted = skill({ id: "trusted-security", domains: ["security"], trusted: true });
    const untrusted = skill({
      id: "untrusted-security",
      domains: ["security"],
      trusted: false,
      contextOverheadTokens: 1,
    });
    const routerConfig = config([borderline], { qualityFloor: 0.9 });
    const result = optimizeRoute(
      request({ domains: ["security"], riskLevel: "high", qualityFloor: 0.9 }),
      snapshot([borderline], [], [untrusted, trusted]),
      routerConfig,
    );

    expect(result.primary.skills).toEqual(["trusted-security"]);
    expect(result.primary.expectedQuality).toBeGreaterThanOrEqual(0.9);
    expect(
      result.considered.some(({ decision }) => decision.skills.includes("untrusted-security")),
    ).toBe(false);
  });

  test("finds the least-cost non-prefix skill combination inside the bounded search space", () => {
    const borderline = model({
      model: "skill-combinations",
      domains: ["general"],
      qualityPrior: 0.861,
      inputCostPerMillion: 100,
      outputCostPerMillion: 0,
    });
    const expensiveOverlap = skill({
      id: "expensive-overlap",
      domains: ["backend", "security"],
      contextOverheadTokens: 10_000,
    });
    const cheapBackend = skill({
      id: "cheap-backend",
      domains: ["backend"],
      contextOverheadTokens: 1,
    });
    const cheapSecurity = skill({
      id: "cheap-security",
      domains: ["security"],
      contextOverheadTokens: 1,
    });
    const result = optimizeRoute(
      request({
        domains: ["backend", "security"],
        qualityFloor: 0.88,
        expectedInputTokens: 100,
        expectedOutputTokens: 100,
      }),
      snapshot([borderline], [], [expensiveOverlap, cheapBackend, cheapSecurity]),
      config([borderline]),
    );

    expect(result.primary.skills).toEqual(["cheap-backend", "cheap-security"]);
    expect(result.primary.expectedQuality).toBeGreaterThanOrEqual(0.88);
    expect(result.primary.expectedCostUsd).toBeCloseTo(0.0102, 8);
    expect(
      result.considered.some(
        ({ decision }) =>
          decision.skills.includes("expensive-overlap") &&
          decision.skills.includes("cheap-backend") &&
          decision.expectedCostUsd > result.primary.expectedCostUsd * 50,
      ),
    ).toBe(true);
  });

  test("automatically considers compatible general agents and skills when both are beneficial", () => {
    const borderline = model({
      model: "general-capabilities",
      domains: ["general"],
      qualityPrior: 0.855,
    });
    const generalAgent = agent({
      id: "general-agent",
      domains: ["general"],
      contextOverheadTokens: 10,
    });
    const generalSkill = skill({
      id: "general-skill",
      domains: ["general"],
      contextOverheadTokens: 10,
    });
    const result = optimizeRoute(
      request({ qualityFloor: 0.88 }),
      snapshot([borderline], [generalAgent], [generalSkill]),
      config([borderline]),
    );

    expect(result.primary).toMatchObject({
      agent: "general-agent",
      skills: ["general-skill"],
    });
    expect(result.primary.expectedQuality).toBeGreaterThanOrEqual(0.88);
  });

  test("caps exhaustive automatic skill enumeration at 256 combinations", () => {
    const capable = model({ model: "bounded-combinations", qualityPrior: 0.99 });
    const skills = Array.from({ length: 9 }, (_, index) =>
      skill({ id: `bounded-skill-${index}`, contextOverheadTokens: index + 1 }),
    );
    const result = optimizeRoute(request(), snapshot([capable], [], skills), config([capable]));

    expect(result.considered).toHaveLength(MAX_AUTOMATIC_SKILL_COMBINATIONS);
    expect(
      result.considered.some(({ decision }) => decision.skills.includes("bounded-skill-8")),
    ).toBe(false);
  });

  test("raises the effective quality floor for risk and strict profiles", () => {
    const capable = model({ qualityPrior: 0.99 });
    const routerConfig = config([capable], { profile: "compliance", qualityFloor: 0.7 });
    const result = optimizeRoute(
      request({ riskLevel: "critical", qualityFloor: 0.5 }),
      snapshot([capable]),
      routerConfig,
    );
    expect(result.effectiveQualityFloor).toBe(0.99);
    expect(result.primary.expectedQuality).toBeGreaterThanOrEqual(0.99);
  });

  test("preserves deliberate stage discounts without dropping below the risk floor", () => {
    const economical = model({ model: "economical-inspector", qualityPrior: 0.83 });
    const routerConfig = config([economical], { qualityFloor: 0.9 });
    const spec = createTaskSpec("Implement a backend endpoint", { qualityFloor: 0.9 });
    const plan = decomposeTask(spec);
    const inspect = plan.nodes.find(({ id }) => id.endsWith("-inspect"));
    if (!inspect) throw new Error("inspect stage fixture is missing");

    const discounted = optimizeRoute(inspect.routeRequest, snapshot([economical]), routerConfig);
    expect(inspect.qualityFloor).toBeCloseTo(0.82);
    expect(discounted.effectiveQualityFloor).toBeCloseTo(0.82);
    expect(discounted.primary.model).toBe("economical-inspector");

    const riskGuarded = optimizeRoute(
      request({ qualityFloor: 0.5, riskLevel: "medium" }),
      snapshot([economical]),
      routerConfig,
    );
    expect(riskGuarded.effectiveQualityFloor).toBe(0.83);
  });

  test("honors provider, model, effort, agent, and skill overrides", () => {
    const first = model({ provider: "one", model: "first", supportedEfforts: ["deep"] });
    const second = model({
      provider: "two",
      model: "second",
      supportedEfforts: ["deep"],
      qualityPrior: 0.91,
    });
    const specialist = agent({ id: "required-agent", skills: ["required-skill"] });
    const requiredSkill = skill({ id: "required-skill" });
    const routerConfig = config([first, second]);
    const result = optimizeRoute(
      request(),
      snapshot([first, second], [specialist], [requiredSkill]),
      routerConfig,
      {
        requiredProvider: "two",
        requiredModel: "second",
        requiredEffort: "deep",
        requiredAgent: "required-agent",
        requiredSkills: ["required-skill"],
      },
    );

    expect(result.primary).toMatchObject({
      provider: "two",
      model: "second",
      effort: "deep",
      agent: "required-agent",
      skills: ["required-skill"],
    });
  });

  test("uses preferred provider only as a deterministic equal-cost tie breaker", () => {
    const one = model({ provider: "one", model: "same-one" });
    const two = model({ provider: "two", model: "same-two" });
    const routerConfig = config([one, two], { preferredProvider: "two" });
    const decision = selectRoute(request(), snapshot([one, two]), routerConfig);
    expect(decision.provider).toBe("two");
  });

  test("caps and orders escalation fallbacks", () => {
    const economical = model({ model: "economical", qualityPrior: 0.9 });
    const stronger = model({
      model: "stronger",
      qualityPrior: 0.94,
      inputCostPerMillion: 2,
      outputCostPerMillion: 7,
    });
    const strongest = model({
      model: "strongest",
      qualityPrior: 0.98,
      inputCostPerMillion: 3,
      outputCostPerMillion: 9,
    });
    const routerConfig = config([economical, stronger, strongest]);
    const result = optimizeRoute(
      request(),
      snapshot([economical, stronger, strongest]),
      routerConfig,
      { maxFallbacks: 1 },
    );
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]?.model).toBe("stronger");
    expect(result.fallbacks[0]?.reason).toContain("Escalation fallback 1");
  });

  test("uses the only fallback slot to escape a provider-wide outage", () => {
    const primary = model({ provider: "subscription", model: "primary", qualityPrior: 0.9 });
    const sameProvider = model({
      provider: "subscription",
      model: "same-provider",
      qualityPrior: 0.92,
      inputCostPerMillion: 2,
      outputCostPerMillion: 6,
    });
    const anotherSameProvider = model({
      provider: "subscription",
      model: "another-same-provider",
      qualityPrior: 0.93,
      inputCostPerMillion: 3,
      outputCostPerMillion: 8,
    });
    const byok = model({
      provider: "byok",
      model: "provider-diverse",
      qualityPrior: 0.95,
      inputCostPerMillion: 4,
      outputCostPerMillion: 10,
    });
    const result = optimizeRoute(
      request(),
      snapshot([primary, sameProvider, anotherSameProvider, byok]),
      config([primary, sameProvider, anotherSameProvider, byok]),
      { maxFallbacks: 1 },
    );

    expect(result.primary.provider).toBe("subscription");
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]).toMatchObject({
      provider: "byok",
      model: "provider-diverse",
    });
  });

  test("keeps a provider-diverse fallback that meets the floor below primary quality", () => {
    const primary = model({ provider: "subscription", model: "primary", qualityPrior: 0.95 });
    const stronger = model({
      provider: "subscription",
      model: "stronger",
      qualityPrior: 0.97,
      inputCostPerMillion: 2,
      outputCostPerMillion: 6,
    });
    const diverse = model({
      provider: "byok",
      model: "floor-qualified",
      qualityPrior: 0.9,
      inputCostPerMillion: 3,
      outputCostPerMillion: 8,
    });
    const result = optimizeRoute(
      request({ qualityFloor: 0.88 }),
      snapshot([primary, stronger, diverse]),
      config([primary, stronger, diverse]),
      { maxFallbacks: 2 },
    );

    expect(result.primary.model).toBe("primary");
    expect(result.fallbacks[0]).toMatchObject({
      provider: "byok",
      model: "floor-qualified",
    });
    expect(result.fallbacks[1]?.model).toBe("stronger");
    expect(result.fallbacks[0]?.expectedQuality).toBeLessThan(result.primary.expectedQuality);
    expect(result.fallbacks[0]?.expectedQuality).toBeGreaterThanOrEqual(
      result.effectiveQualityFloor,
    );
  });
});

describe("routing safety and failure diagnostics", () => {
  test("keeps Claude and Codex agents and skills within their provider scopes", () => {
    const claude = model({ provider: "claude-code", model: "claude" });
    const codex = model({ provider: "codex", model: "codex" });
    const codexAgent = agent({ id: "codex-agent", providers: ["codex"] });
    const claudeSkill = skill({ id: "claude-skill", providers: ["claude-code"] });
    const routerConfig = config([claude, codex]);
    const capabilities = snapshot([claude, codex], [codexAgent], [claudeSkill]);

    expect(() =>
      optimizeRoute(request(), capabilities, routerConfig, {
        requiredProvider: "claude-code",
        requiredAgent: "codex-agent",
      }),
    ).toThrow("Required agent is not available for the selected provider/model set");
    expect(() =>
      optimizeRoute(request(), capabilities, routerConfig, {
        requiredProvider: "codex",
        requiredSkills: ["claude-skill"],
      }),
    ).toThrow("Required skill does not share an eligible provider");

    expect(
      optimizeRoute(request(), capabilities, routerConfig, {
        requiredAgent: "codex-agent",
      }).primary,
    ).toMatchObject({ provider: "codex", agent: "codex-agent" });
    expect(
      optimizeRoute(request(), capabilities, routerConfig, {
        requiredSkills: ["claude-skill"],
      }).primary,
    ).toMatchObject({ provider: "claude-code", skills: ["claude-skill"] });
  });

  test("disambiguates the same runtime id by the selected provider", () => {
    const claude = model({ provider: "claude-code", model: "claude" });
    const codex = model({ provider: "codex", model: "codex" });
    const agents = [
      agent({ id: "shared-agent", providers: ["claude-code"] }),
      agent({ id: "shared-agent", providers: ["codex"] }),
    ];
    const skills = [
      skill({ id: "shared-skill", providers: ["claude-code"] }),
      skill({ id: "shared-skill", providers: ["codex"] }),
    ];
    const routerConfig = config([claude, codex]);
    const capabilities = snapshot([claude, codex], agents, skills);

    for (const provider of ["claude-code", "codex"] as const) {
      expect(
        optimizeRoute(request(), capabilities, routerConfig, {
          requiredProvider: provider,
          requiredAgent: "shared-agent",
          requiredSkills: ["shared-skill"],
        }).primary,
      ).toMatchObject({
        provider,
        agent: "shared-agent",
        skills: ["shared-skill"],
      });
    }
  });

  test("uses only capabilities whose bounded instructions can be delivered in the prompt", () => {
    const capable = model({
      model: "prompt-capable",
      qualityPrior: 0.99,
      tools: allTools.filter((tool) => tool !== "Agent" && tool !== "Skill"),
    });
    const selected = optimizeRoute(
      request(),
      snapshot([capable], [agent()], [skill()]),
      config([capable]),
      { requiredAgent: "backend-specialist", requiredSkills: ["backend-patterns"] },
    );
    expect(selected.primary.tools).not.toContain("Agent");
    expect(selected.primary.tools).not.toContain("Skill");

    const unavailable = agent();
    delete unavailable.instructionCharacters;
    expect(() =>
      optimizeRoute(request(), snapshot([capable], [unavailable]), config([capable]), {
        requiredAgent: "backend-specialist",
      }),
    ).toThrow("Required agent is incompatible");
  });

  test("rejects capability overhead above the step input budget before runtime", () => {
    const capable = model({ qualityPrior: 0.99 });
    expect(() =>
      optimizeRoute(
        request({ expectedInputTokens: 4_000, maxInputTokens: 4_500 }),
        snapshot([capable], [agent({ contextOverheadTokens: 1_000 })]),
        config([capable]),
        { requiredAgent: "backend-specialist" },
      ),
    ).toThrow("input and capability context exceed the step input budget");
  });

  test("never lets capability metadata widen the authorized tool ceiling", () => {
    const capable = model({ qualityPrior: 0.99 });
    const writeSkill = skill({ id: "write-skill", requiredTools: ["Write"] });
    const readOnly = request({ requiredTools: ["Read"] });

    const selected = optimizeRoute(
      readOnly,
      snapshot([capable], [], [writeSkill]),
      config([capable]),
    );
    expect(selected.primary.skills).toEqual([]);
    expect(selected.primary.tools).toEqual(["Read"]);
    expect(() =>
      optimizeRoute(readOnly, snapshot([capable], [], [writeSkill]), config([capable]), {
        requiredSkills: ["write-skill"],
      }),
    ).toThrow("Required skill is incompatible");
  });

  test("rejects incompatible or untrusted required capabilities", () => {
    const capable = model({ qualityPrior: 0.99 });
    const lowRiskAgent = agent({ id: "low-risk", riskCeiling: "low" });
    const untrusted = skill({ id: "untrusted", trusted: false, domains: ["security"] });
    const routerConfig = config([capable]);
    const highRiskRequest = request({
      domains: ["security"],
      riskLevel: "high",
      qualityFloor: 0.9,
    });

    expect(() =>
      optimizeRoute(highRiskRequest, snapshot([capable], [lowRiskAgent]), routerConfig, {
        requiredAgent: "low-risk",
      }),
    ).toThrow("Required agent is incompatible");
    expect(() =>
      optimizeRoute(highRiskRequest, snapshot([capable], [], [untrusted]), routerConfig, {
        requiredSkills: ["untrusted"],
      }),
    ).toThrow("incompatible or untrusted");
  });

  test("rejects contradictory disable flags and missing manual selections", () => {
    const capable = model({ qualityPrior: 0.99 });
    const routerConfig = config([capable]);
    expect(() =>
      optimizeRoute(request(), snapshot([capable], [agent()]), routerConfig, {
        requiredAgent: "backend-specialist",
        disableAgents: true,
      }),
    ).toThrow("requiredAgent cannot be combined with disableAgents");
    expect(() =>
      optimizeRoute(request(), snapshot([capable], [], [skill()]), routerConfig, {
        requiredSkills: ["backend-patterns"],
        disableSkills: true,
      }),
    ).toThrow("requiredSkills cannot be combined with disableSkills");
    expect(() =>
      optimizeRoute(request(), snapshot([capable]), routerConfig, {
        requiredModel: "missing",
      }),
    ).toThrow("Required provider/model is not available");
    expect(() =>
      optimizeRoute(request(), snapshot([capable]), routerConfig, {
        requiredEffort: "max",
      }),
    ).toThrow("Required effort is not supported");
  });

  test("reports quality, tool, context, and budget rejection reasons", () => {
    const incapable = model({
      qualityPrior: 0.5,
      tools: ["Read"],
      contextWindow: 1_000,
      maxOutputTokens: 100,
      inputCostPerMillion: 100,
      outputCostPerMillion: 100,
    });
    const routerConfig = config([incapable], { qualityFloor: 0.9 });
    expect(() =>
      optimizeRoute(
        request({ expectedInputTokens: 2_000, expectedOutputTokens: 500 }),
        snapshot([incapable]),
        routerConfig,
        { maxCostUsd: 0.001 },
      ),
    ).toThrow(
      /lacks one or more required tools[\s\S]*context window[\s\S]*output limit[\s\S]*below 0\.880[\s\S]*exceeds step budget/u,
    );
  });

  test("validates token and cost inputs before evaluating routes", () => {
    const capable = model({ qualityPrior: 0.99 });
    const routerConfig = config([capable]);
    expect(() =>
      optimizeRoute(request({ expectedInputTokens: -1 }), snapshot([capable]), routerConfig),
    ).toThrow("Expected token counts cannot be negative");
    expect(() =>
      optimizeRoute(request(), snapshot([capable]), routerConfig, { maxCostUsd: 0 }),
    ).toThrow("maxCostUsd must be greater than zero");
    expect(() =>
      optimizeRoute(request({ maxLatencyMs: 0 }), snapshot([capable]), routerConfig),
    ).toThrow("maxLatencyMs must be greater than zero");
  });

  test("rejects a route whose predicted latency exceeds the run deadline", () => {
    const slow = model({ qualityPrior: 0.99, latencyPriorMs: 10_000 });
    expect(() =>
      optimizeRoute(request({ maxLatencyMs: 100 }), snapshot([slow]), config([slow])),
    ).toThrow("expected latency 10000ms exceeds run deadline 100ms");
  });
});

describe("whole-plan routing", () => {
  test("routes every DAG node and preserves fallbacks outside the execution plan", () => {
    const capable = model({ model: "capable", qualityPrior: 0.94 });
    const premium = model({
      model: "premium",
      qualityPrior: 0.98,
      inputCostPerMillion: 2,
      outputCostPerMillion: 8,
    });
    const routerConfig = config([capable, premium]);
    const spec = createTaskSpec("Implement a backend endpoint", {
      id: "route-plan-task",
      qualityFloor: 0.88,
      budget: { maxCostUsd: 5, maxAttempts: 2 },
    });
    const source = decomposeTask(spec, {
      planId: "route-plan",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const routed = routeExecutionPlan(source, snapshot([capable, premium]), routerConfig);

    expect(source.nodes.every(({ route }) => route === undefined)).toBe(true);
    expect(routed.plan.nodes.every(({ route }) => route?.model === "capable")).toBe(true);
    expect(Object.keys(routed.fallbacks)).toEqual(routed.plan.nodes.map(({ id }) => id));
    expect(routed.plan.predictedPrimaryCallCostUsd).toBe(routed.predictedPrimaryCallCostUsd);
    expect(routed.predictedPrimaryCallCostUsd).toBeLessThanOrEqual(spec.budget.maxCostUsd);
  });
});
