import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type {
  AgentCapability,
  CapabilitySnapshot,
  ModelCapability,
  PlanNode,
  ProviderAdapter,
  RouteDecision,
  RouterConfig,
  SkillCapability,
} from "../src/contracts.ts";
import { SuperRouter } from "../src/orchestrator.ts";
import { inspectProject } from "../src/project-context.ts";
import {
  assertRouteCapabilities,
  routeCapabilityValidationMessage,
  validateRouteCapabilities,
} from "../src/routing/capability-validation.ts";
import { resolveStatePaths } from "../src/state-paths.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("route capability validation", () => {
  test("accepts a compatible model, agent, skill, tool set, risk, and context", () => {
    const validation = validateRouteCapabilities(snapshot(), node(), route());

    expect(validation).toEqual({ valid: true, errors: [] });
    expect(routeCapabilityValidationMessage(snapshot(), node(), route())).toBe(true);
    expect(() => assertRouteCapabilities(snapshot(), node(), route())).not.toThrow();
  });

  test("rejects absent, disabled, and incompatible providers or models", () => {
    const absent = validateRouteCapabilities(snapshot(), node(), route({ provider: "removed" }));
    expect(absent.errors).toEqual(
      expect.arrayContaining([
        "Provider removed is not enabled or registered",
        "Model removed/model-a is not enabled or registered",
      ]),
    );

    const incompatibleModel = model({
      enabled: false,
      taskTypes: ["review"],
      domains: ["frontend"],
      supportedEfforts: ["economy"],
      tools: ["Agent", "Skill", "Grep", "Bash"],
    });
    const invalidRoute = route({
      effort: "max",
      tools: ["Agent", "Skill", "Grep", "Bash", "Shell", "shell"],
    });
    const invalid = validateRouteCapabilities(
      snapshot({ models: [incompatibleModel] }),
      node(),
      invalidRoute,
    );

    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "Model provider-a/model-a is disabled",
        "Model provider-a/model-a does not support max effort",
        "Model provider-a/model-a does not support implement",
        "Model provider-a/model-a is incompatible with the step domains",
        "Route is missing required step tool Read",
        "Model provider-a/model-a does not support route tool Shell",
        "Route contains duplicate tools",
      ]),
    );
  });

  test("rejects missing or incompatible agents and skills using the stricter plan risk", () => {
    const missing = validateRouteCapabilities(
      snapshot({ agents: [], skills: [] }),
      node(),
      route(),
    );
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        "Agent agent-a is not enabled or registered",
        "Skill skill-a is not enabled or registered",
      ]),
    );

    const incompatibleAgent = agent({
      enabled: false,
      taskTypes: ["review"],
      domains: ["frontend"],
      riskCeiling: "medium",
      tools: ["Write"],
    });
    const incompatibleSkill = skill({
      enabled: false,
      trusted: false,
      taskTypes: ["review"],
      domains: ["frontend"],
      requiredTools: ["Write"],
    });
    const conservativeNode = node({
      riskLevel: "low",
      routeRequest: { ...node().routeRequest, riskLevel: "high" },
    });
    const invalid = validateRouteCapabilities(
      snapshot({ agents: [incompatibleAgent], skills: [incompatibleSkill] }),
      conservativeNode,
      route(),
    );

    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "Agent agent-a is disabled",
        "Agent agent-a does not support implement",
        "Agent agent-a is incompatible with the step domains",
        "Agent agent-a risk ceiling is below high",
        "Route for agent agent-a is missing agent tool Write",
        "Skill skill-a is disabled",
        "Skill skill-a does not support implement",
        "Skill skill-a is incompatible with the step domains",
        "Skill skill-a is not trusted for high risk",
        "Route for skill skill-a is missing required tool Write",
      ]),
    );
    expect(() =>
      assertRouteCapabilities(
        snapshot({ agents: [incompatibleAgent], skills: [incompatibleSkill] }),
        conservativeNode,
        route(),
      ),
    ).toThrow("Route capability validation failed");
  });

  test("rejects agents and skills scoped to a different runtime provider", () => {
    const invalid = validateRouteCapabilities(
      snapshot({
        models: [model({ provider: "claude-code" })],
        agents: [agent({ providers: ["codex"] })],
        skills: [skill({ providers: ["codex"] })],
      }),
      node(),
      route({ provider: "claude-code" }),
    );

    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "Agent agent-a is not available for provider claude-code",
        "Skill skill-a is not available for provider claude-code",
      ]),
    );

    const providerMatched = validateRouteCapabilities(
      snapshot({
        models: [model({ provider: "claude-code" })],
        agents: [agent({ providers: ["codex"] }), agent({ providers: ["claude-code"] })],
        skills: [skill({ providers: ["codex"] }), skill({ providers: ["claude-code"] })],
      }),
      node(),
      route({ provider: "claude-code" }),
    );
    expect(providerMatched).toEqual({ valid: true, errors: [] });
  });

  test("rejects effort-adjusted output and total context above current model limits", () => {
    const constrainedModel = model({
      supportedEfforts: ["deep"],
      contextWindow: 850,
      maxOutputTokens: 250,
    });
    const invalid = validateRouteCapabilities(
      snapshot({ models: [constrainedModel] }),
      node(),
      route({ effort: "deep" }),
    );

    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "Model provider-a/model-a output limit is below the planned output",
        "Model provider-a/model-a context window is below the planned context",
      ]),
    );
    expect(
      routeCapabilityValidationMessage(
        snapshot({ models: [constrainedModel] }),
        node(),
        route({ effort: "deep" }),
      ),
    ).toContain("output limit is below the planned output");

    const stepBounded = validateRouteCapabilities(
      snapshot(),
      node({ contextBudget: 650 }),
      route(),
    );
    expect(stepBounded.errors).toContain(
      "Selected capability context exceeds the step input budget",
    );
  });

  test("rejects route tools that exceed the step authorization ceiling", () => {
    const invalid = validateRouteCapabilities(
      snapshot({ models: [model({ tools: [...model().tools, "Write"] })] }),
      node(),
      route({ tools: [...route().tools, "Write"] }),
    );

    expect(invalid.errors).toContain("Route contains unauthorized tool Write");
  });
});

describe("SuperRouter capability revalidation", () => {
  test("refreshes capabilities before a fallback and blocks a replaced agent", async () => {
    const project = await mkdtemp(join(tmpdir(), "super-router-capability-refresh-"));
    temporaryDirectories.push(project);
    const agentPath = join(project, "agents/runtime-refresh-agent.md");
    await writeManifest(agentPath, true);

    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "fake",
      isAvailable: async () => true,
      execute: async () => {
        calls += 1;
        await writeManifest(agentPath, false);
        return {
          output: "",
          artifacts: [],
          usage: {
            inputTokens: 10,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            costUsd: 0.000_01,
            costFinal: true,
            durationMs: 1,
          },
        };
      },
    };
    const router = new SuperRouter({
      config: runtimeConfig(),
      cwd: project,
      adapters: [adapter],
      memory: false,
      trustProject: true,
    });

    const result = await router.run("Document the public API", {
      requiredAgent: "runtime-refresh-agent",
    });

    expect(calls).toBe(1);
    expect(result.state).toBe("needs-escalation");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.attempt).toBe(2);
    expect(result.steps[0]?.error).toContain("Agent runtime-refresh-agent is disabled");
  });

  test("rejects a synthetic project collision alias before provider execution", async () => {
    const project = await temporaryDirectory("super-router-capability-alias-");
    const manifest = `---
name: foo
description: Documents public APIs
task-types: [document]
domains: [general]
---
Document the requested API.
`;
    const claudePath = join(project, ".claude/agents/foo.md");
    const genericPath = join(project, "agents/foo.md");
    await mkdir(dirname(claudePath), { recursive: true });
    await mkdir(dirname(genericPath), { recursive: true });
    await writeFile(claudePath, manifest, "utf8");
    await writeFile(genericPath, manifest, "utf8");
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "fake",
      isAvailable: async () => true,
      execute: async () => {
        calls += 1;
        throw new Error("synthetic aliases must never reach the adapter");
      },
    };
    const router = new SuperRouter({
      config: runtimeConfig(),
      cwd: project,
      adapters: [adapter],
      memory: false,
      trustProject: true,
    });

    await expect(
      router.run("Document the public API", { requiredAgent: "project:foo" }),
    ).rejects.toThrow("Required agent is incompatible");
    expect(calls).toBe(0);
  });
});

describe("SuperRouter telemetry retention", () => {
  test("awaits default JSONL retention before serving capabilities", async () => {
    const project = await temporaryDirectory("super-router-retention-project-");
    const state = await temporaryDirectory("super-router-retention-state-");

    await withStateDirectory(state, async () => {
      const projectContext = inspectProject(project);
      const telemetryDirectory = resolveStatePaths(
        projectContext.cwd,
        projectContext.projectId,
      ).telemetry;
      await mkdir(telemetryDirectory, { recursive: true });
      const expiredFile = join(telemetryDirectory, "events-2020-01-01.jsonl");
      await writeFile(expiredFile, '{"type":"run.started"}\n', "utf8");
      const expiredAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
      await utimes(expiredFile, expiredAt, expiredAt);
      const config = runtimeConfig();
      config.telemetry = { enabled: true, includePromptHash: false, retentionDays: 1 };
      const router = new SuperRouter({
        config,
        cwd: project,
        adapters: [],
        memory: false,
      });

      const capabilities = await router.capabilities();

      expect(capabilities.models).toHaveLength(1);
      expect(await readdir(telemetryDirectory)).not.toContain("events-2020-01-01.jsonl");
    });
  });

  test("does not fail public operations when default retention cleanup fails", async () => {
    const project = await temporaryDirectory("super-router-retention-failure-project-");
    const state = await temporaryDirectory("super-router-retention-failure-state-");

    await withStateDirectory(state, async () => {
      const projectContext = inspectProject(project);
      const telemetryDirectory = resolveStatePaths(
        projectContext.cwd,
        projectContext.projectId,
      ).telemetry;
      await mkdir(dirname(telemetryDirectory), { recursive: true });
      await writeFile(telemetryDirectory, "not a directory", "utf8");
      const config = runtimeConfig();
      config.telemetry = { enabled: true, includePromptHash: false, retentionDays: 1 };
      const router = new SuperRouter({
        config,
        cwd: project,
        adapters: [],
        memory: false,
      });

      await expect(router.capabilities()).resolves.toMatchObject({
        models: [expect.objectContaining({ provider: "fake", model: "document-model" })],
      });
    });
  });
});

function node(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id: "step-a",
    title: "Implement backend change",
    objective: "Implement a bounded backend change",
    dependencies: [],
    expectedArtifact: { type: "patch", description: "Validated patch" },
    riskLevel: "high",
    qualityFloor: 0.9,
    routeRequest: {
      stepId: "step-a",
      taskIntent: "implement",
      domains: ["backend"],
      riskLevel: "high",
      qualityFloor: 0.9,
      expectedInputTokens: 500,
      expectedOutputTokens: 200,
      requiredTools: ["Read", "Grep", "Bash"],
    },
    contextRefs: [],
    contextBudget: 1_000,
    outputBudget: 200,
    maxCostUsd: 1,
    maxAttempts: 2,
    verification: {
      commands: [],
      requireIndependentReview: false,
      requireHumanApproval: false,
      minimumScore: 0.9,
    },
    ...overrides,
  };
}

function route(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    provider: "provider-a",
    model: "model-a",
    effort: "balanced",
    agent: "agent-a",
    skills: ["skill-a"],
    tools: ["Read", "Grep", "Bash"],
    expectedQuality: 0.95,
    expectedCostUsd: 0.01,
    expectedLatencyMs: 10,
    reason: "compatible test route",
    ...overrides,
  };
}

function model(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    provider: "provider-a",
    model: "model-a",
    displayName: "Model A",
    taskTypes: ["implement"],
    domains: ["general"],
    supportedEfforts: ["balanced", "deep"],
    tools: ["Read", "Agent", "Skill", "Grep", "Bash"],
    contextWindow: 10_000,
    maxOutputTokens: 2_000,
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    qualityPrior: 0.95,
    latencyPriorMs: 10,
    enabled: true,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentCapability> = {}): AgentCapability {
  return {
    id: "agent-a",
    description: "Backend implementation agent",
    instructionCharacters: 128,
    taskTypes: ["implement"],
    domains: ["backend"],
    tools: ["Grep"],
    skills: ["skill-a"],
    riskCeiling: "critical",
    contextOverheadTokens: 100,
    enabled: true,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillCapability> = {}): SkillCapability {
  return {
    id: "skill-a",
    description: "Backend implementation conventions",
    instructionCharacters: 128,
    taskTypes: ["implement"],
    domains: ["backend"],
    requiredTools: ["Bash"],
    contextOverheadTokens: 100,
    trusted: true,
    enabled: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    models: [model()],
    agents: [agent()],
    skills: [skill()],
    discoveredAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function runtimeConfig(): RouterConfig {
  return {
    ...structuredClone(defaultConfig),
    qualityFloor: 0.8,
    memory: { enabled: false, persistRawPrompts: false, maxResults: 1 },
    telemetry: { enabled: false, includePromptHash: false, retentionDays: 1 },
    budget: {
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxCostUsd: 1,
      maxDurationMs: 10_000,
      maxAttempts: 2,
    },
    providers: [
      {
        id: "fake",
        enabled: true,
        transport: "cli",
        billingMode: "metered",
        executable: "unused-test-runtime",
        defaultModel: "document-model",
        models: [
          model({
            provider: "fake",
            model: "document-model",
            displayName: "Document Model",
            taskTypes: ["document"],
            supportedEfforts: ["economy", "balanced"],
            tools: ["Read", "Glob", "Grep", "Edit", "Agent"],
            contextWindow: 100_000,
            maxOutputTokens: 10_000,
          }),
        ],
      },
    ],
  };
}

async function writeManifest(path: string, enabled: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `---
name: runtime-refresh-agent
description: Documents public APIs during capability refresh tests
task-types: [document]
domains: [general]
risk-ceiling: medium
enabled: ${enabled}
---
Document the requested API.
`,
    "utf8",
  );
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function withStateDirectory<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.SUPER_ROUTER_STATE_DIR;
  process.env.SUPER_ROUTER_STATE_DIR = directory;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.SUPER_ROUTER_STATE_DIR;
    else process.env.SUPER_ROUTER_STATE_DIR = previous;
  }
}
