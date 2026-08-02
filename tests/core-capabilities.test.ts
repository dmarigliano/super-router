import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { RouteDecision } from "../src/contracts.ts";
import {
  CapabilityRegistry,
  discoverCapabilities,
  modelsFromConfig,
} from "../src/routing/capability-registry.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "super-router-capability-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("capability discovery", () => {
  test("parses manifests but never trusts self-asserted metadata from explicit roots", async () => {
    const directory = await temporaryDirectory();
    const agents = join(directory, "isolated-agents");
    const skills = join(directory, "isolated-skills");
    await createFile(
      join(agents, "security-reviewer.md"),
      `---
name: security-reviewer
description: Reviews backend authentication vulnerabilities
task-types: [review, security-audit]
domains: [security, backend]
tools: [Read, Grep]
skills: [secure-review]
risk-ceiling: critical
enabled: true
---
Focused security reviewer.
`,
    );
    await createFile(
      join(skills, "secure-review", "SKILL.md"),
      `---
name: secure-review
description: Audits authentication boundaries
task-types:
  - review
  - security-audit
domains: [security]
required-tools: [Read, Grep]
trusted: true
enabled: true
---
Apply a deterministic security checklist.
`,
    );
    await createFile(
      join(skills, "community", "SKILL.md"),
      "# Community helper\n\nImplement general code changes.",
    );

    const snapshot = await discoverCapabilities(defaultConfig, {
      agentRoots: [agents],
      skillRoots: [skills],
      includeProjectRoots: false,
      includeUserRoots: false,
    });

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      id: "security-reviewer",
      taskTypes: ["review", "security-audit"],
      domains: ["security", "backend"],
      tools: ["Read", "Grep"],
      skills: ["secure-review"],
      riskCeiling: "critical",
      enabled: true,
    });
    expect(snapshot.agents[0]?.providers).toBeUndefined();
    expect(snapshot.agents[0]?.instructionCharacters).toBe("Focused security reviewer.".length);
    expect(JSON.stringify(snapshot)).not.toContain("Focused security reviewer.");
    expect(snapshot.agents[0]?.contextOverheadTokens).toBeGreaterThan(0);
    expect(snapshot.skills.find(({ id }) => id === "secure-review")).toMatchObject({
      trusted: false,
      requiredTools: ["Read", "Grep"],
    });
    expect(snapshot.skills.find(({ id }) => id === "secure-review")?.providers).toBeUndefined();
    expect(snapshot.skills.find(({ id }) => id === "community")).toMatchObject({
      trusted: false,
      enabled: true,
    });
  });

  test("derives provider scope from runtime roots and disables synthetic collision aliases", async () => {
    const directory = await temporaryDirectory();
    await createFile(
      join(directory, ".claude/agents/claude-agent.md"),
      "---\nname: claude-agent\nproviders: [codex]\n---\nReview code.",
    );
    await createFile(
      join(directory, ".codex/agents/codex-agent.md"),
      "---\nname: codex-agent\nproviders: [claude-code]\n---\nReview code.",
    );
    await createFile(join(directory, "agents/neutral-agent.md"), "# Neutral\n\nReview code.");
    await createFile(
      join(directory, ".claude/skills/claude-skill/SKILL.md"),
      "---\nname: claude-skill\n---\nReview code.",
    );
    await createFile(
      join(directory, ".agents/skills/codex-official/SKILL.md"),
      "---\nname: codex-official\nproviders: [claude-code]\n---\nReview code.",
    );
    await createFile(
      join(directory, ".codex/skills/codex-skill/SKILL.md"),
      "---\nname: codex-skill\n---\nReview code.",
    );
    await createFile(
      join(directory, "skills/neutral-skill/SKILL.md"),
      "---\nname: neutral-skill\n---\nReview code.",
    );
    await createFile(
      join(directory, ".claude/agents/shared.md"),
      "---\nname: shared\n---\nClaude runtime.",
    );
    await createFile(
      join(directory, ".codex/agents/shared.md"),
      "---\nname: shared\n---\nCodex runtime.",
    );

    const snapshot = await discoverCapabilities(defaultConfig, {
      cwd: directory,
      includeUserRoots: false,
    });

    expect(snapshot.agents.find(({ id }) => id === "claude-agent")?.providers).toEqual([
      "claude-code",
    ]);
    expect(snapshot.agents.find(({ id }) => id === "codex-agent")?.providers).toEqual(["codex"]);
    expect(snapshot.agents.find(({ id }) => id === "neutral-agent")?.providers).toBeUndefined();
    expect(snapshot.skills.find(({ id }) => id === "claude-skill")?.providers).toEqual([
      "claude-code",
    ]);
    expect(snapshot.skills.find(({ id }) => id === "codex-skill")?.providers).toEqual(["codex"]);
    expect(snapshot.skills.find(({ id }) => id === "codex-official")?.providers).toEqual(["codex"]);
    expect(snapshot.skills.find(({ id }) => id === "neutral-skill")?.providers).toBeUndefined();
    expect(
      snapshot.agents
        .filter(({ id }) => id === "shared")
        .map(({ providers, enabled }) => ({ providers, enabled })),
    ).toEqual([
      { providers: ["claude-code"], enabled: true },
      { providers: ["codex"], enabled: true },
    ]);
    expect(snapshot.agents.some(({ id }) => id === "project:shared")).toBe(false);
  });

  test("discovers Codex skills from the official user-level Agent Skills directory", async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, "workspace");
    const home = join(directory, "home");
    await mkdir(workspace, { recursive: true });
    await createFile(
      join(home, ".agents/skills/super-router/SKILL.md"),
      "---\nname: super-router\n---\nRoute work with explicit budgets.",
    );

    const snapshot = await discoverCapabilities(defaultConfig, {
      cwd: workspace,
      homeDir: home,
      includeProjectRoots: false,
    });

    expect(snapshot.skills.find(({ id }) => id === "super-router")?.providers).toEqual(["codex"]);
  });

  test("isolates explicitly selected roots and never follows symbolic links", async () => {
    const directory = await temporaryDirectory();
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside");
    await createFile(join(allowed, "visible.md"), "# Visible\n\nReview code.");
    await createFile(join(outside, "hidden.md"), "# Hidden\n\nReview secrets.");
    await symlink(outside, join(allowed, "escape"));

    const snapshot = await discoverCapabilities(defaultConfig, {
      cwd: directory,
      homeDir: outside,
      agentRoots: [allowed],
      skillRoots: [],
      includeProjectRoots: false,
      includeUserRoots: false,
    });

    expect(snapshot.agents.map(({ id }) => id)).toEqual(["visible"]);
    expect(snapshot.agents.some(({ id }) => id === "hidden")).toBe(false);
  });

  test("rejects project capability roots whose canonical target escapes the workspace", async () => {
    const project = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await createFile(join(outside, "escaped.md"), "# Escaped\n\nRead outside data.");
    await symlink(outside, join(project, "agents"));

    const snapshot = await discoverCapabilities(defaultConfig, {
      cwd: project,
      includeUserRoots: false,
    });

    expect(snapshot.agents.some(({ id }) => id === "escaped")).toBe(false);
  });

  test("deduplicates declared ids deterministically and ignores README manifests", async () => {
    const directory = await temporaryDirectory();
    const agents = join(directory, "agents");
    await createFile(
      join(agents, "a-first.md"),
      "---\nname: duplicate\ndescription: First manifest\n---\nFirst.",
    );
    await createFile(
      join(agents, "z-second.md"),
      "---\nname: duplicate\ndescription: Second manifest\n---\nSecond.",
    );
    await createFile(join(agents, "README.md"), "# This is not an agent");

    const snapshot = await discoverCapabilities(defaultConfig, {
      agentRoots: [agents],
      includeProjectRoots: false,
      includeUserRoots: false,
    });
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.description).toBe("First manifest");
  });

  test("enforces bounded traversal settings", async () => {
    await expect(
      discoverCapabilities(defaultConfig, {
        includeProjectRoots: false,
        includeUserRoots: false,
        maxDepth: 33,
      }),
    ).rejects.toThrow("maxDepth must be an integer between 0 and 32");
    await expect(
      discoverCapabilities(defaultConfig, {
        includeProjectRoots: false,
        includeUserRoots: false,
        maxFiles: 0,
      }),
    ).rejects.toThrow("maxFiles must be a positive integer");
    await expect(
      discoverCapabilities(defaultConfig, {
        includeProjectRoots: false,
        includeUserRoots: false,
        maxFiles: 4_001,
      }),
    ).rejects.toThrow("no greater than 4000");
    await expect(
      discoverCapabilities(defaultConfig, {
        includeProjectRoots: false,
        includeUserRoots: false,
        maxBytes: 32 * 1_048_576 + 1,
      }),
    ).rejects.toThrow("maxBytes must be an integer between 1");
    await expect(
      discoverCapabilities(defaultConfig, {
        includeProjectRoots: false,
        includeUserRoots: false,
        maxEntries: 20_001,
      }),
    ).rejects.toThrow("maxEntries must be an integer between 1 and 20000");
  });

  test("bounds aggregate bytes and hostile manifest metadata fail-closed", async () => {
    const directory = await temporaryDirectory();
    const agents = join(directory, "isolated-agents");
    const skills = join(directory, "isolated-skills");
    const boundedManifest = `---
name: bounded
description: ${"d".repeat(700)}
tools: [${Array.from({ length: 100 }, (_, index) => `tool-${index}`).join(",")}]
---
Review code.
`;
    const secondManifest = "---\nname: second\n---\nReview code.\n";
    await createFile(join(agents, "bounded.md"), boundedManifest);
    await createFile(
      join(agents, "unsafe.md"),
      "---\nname: ../unsafe\n---\nMust never become executable.",
    );
    await createFile(
      join(agents, "too-long.md"),
      `---\nname: ${"a".repeat(129)}\n---\nMust never become executable.`,
    );
    await createFile(
      join(agents, "oversized-body.md"),
      `---\nname: oversized-body\n---\n${"x".repeat(4_097)}`,
    );
    await createFile(join(skills, "second", "SKILL.md"), secondManifest);

    const metadataBounded = await discoverCapabilities(defaultConfig, {
      agentRoots: [agents],
      skillRoots: [],
      includeProjectRoots: false,
      includeUserRoots: false,
    });
    expect(metadataBounded.agents.map(({ id }) => id)).toEqual(["bounded", "oversized-body"]);
    expect(metadataBounded.agents[0]?.description).toHaveLength(500);
    expect(metadataBounded.agents[0]?.tools).toHaveLength(64);
    expect(
      metadataBounded.agents.find(({ id }) => id === "oversized-body")?.instructionCharacters,
    ).toBeUndefined();

    const byteBounded = await discoverCapabilities(defaultConfig, {
      agentRoots: [agents],
      skillRoots: [skills],
      includeProjectRoots: false,
      includeUserRoots: false,
      maxBytes: Math.max(Buffer.byteLength(boundedManifest), Buffer.byteLength(secondManifest)),
    });
    expect(byteBounded.agents.length + byteBounded.skills.length).toBeLessThanOrEqual(1);

    const entryBounded = await discoverCapabilities(defaultConfig, {
      agentRoots: [agents],
      skillRoots: [skills],
      includeProjectRoots: false,
      includeUserRoots: false,
      maxEntries: 1,
    });
    expect(entryBounded.agents.length + entryBounded.skills.length).toBeLessThanOrEqual(1);
  });
});

describe("capability registry isolation", () => {
  test("catalogs only enabled providers and models and canonicalizes provider ids", () => {
    const config = structuredClone(defaultConfig);
    const enabled = config.providers[0];
    const disabled = config.providers[1];
    if (!enabled || !disabled || !enabled.models[0] || !enabled.models[1]) {
      throw new Error("default capability fixtures are missing");
    }
    enabled.models[0].enabled = false;
    enabled.models[1].provider = "untrusted-model-manifest-provider";
    disabled.models = [{ ...enabled.models[1], enabled: true }];

    const models = modelsFromConfig(config);
    expect(models.some(({ model }) => model === enabled.models[0]?.model)).toBe(false);
    expect(models.every(({ provider }) => provider === enabled.id)).toBe(true);
    expect(models.some(({ model }) => model === enabled.models[1]?.model)).toBe(true);
  });

  test("returns defensive snapshots and lookup results", async () => {
    const directory = await temporaryDirectory();
    const agents = join(directory, "agents");
    const skills = join(directory, "skills");
    const reviewerPath = join(agents, "reviewer.md");
    const testerPath = join(skills, "tester", "SKILL.md");
    await createFile(
      reviewerPath,
      "---\nname: reviewer\ndescription: Review backend code\n---\nReview.",
    );
    await createFile(testerPath, "---\nname: tester\ndescription: Test backend code\n---\nTest.");
    const registry = new CapabilityRegistry(defaultConfig, {
      agentRoots: [agents],
      skillRoots: [skills],
      includeProjectRoots: false,
      includeUserRoots: false,
    });
    await registry.refresh();

    const first = registry.snapshot();
    const firstAgent = first.agents[0];
    if (!firstAgent) throw new Error("agent was not discovered");
    firstAgent.id = "mutated";
    first.models.splice(0);
    expect(registry.snapshot().agents[0]?.id).toBe("reviewer");
    expect(registry.snapshot().models.length).toBeGreaterThan(0);

    const foundAgent = registry.findAgent("reviewer");
    if (!foundAgent) throw new Error("agent was not discovered");
    foundAgent.description = "mutated";
    expect(registry.findAgent("reviewer")?.description).toBe("Review backend code");

    const foundSkill = registry.findSkill("tester");
    expect(foundSkill?.id).toBe("tester");
    expect(registry.findModel("claude-code", "sonnet")?.model).toBe("sonnet");
    expect(registry.findModel("missing", "missing")).toBeUndefined();

    const selectedRoute: RouteDecision = {
      provider: "claude-code",
      model: "sonnet",
      effort: "balanced",
      agent: "reviewer",
      skills: ["tester"],
      tools: [],
      expectedQuality: 0.9,
      expectedCostUsd: 0,
      expectedLatencyMs: 1,
      reason: "generation isolation test",
    };
    const firstGeneration = await registry.refreshRoute(selectedRoute);
    await createFile(
      reviewerPath,
      "---\nname: reviewer\ndescription: Review backend code\n---\nUpdated review.",
    );
    await createFile(
      testerPath,
      "---\nname: tester\ndescription: Test backend code\n---\nUpdated test.",
    );
    const secondGeneration = await registry.refreshRoute(selectedRoute);

    expect(firstGeneration.materialized?.agent?.instructions).toBe("Review.");
    expect(firstGeneration.materialized?.skills[0]?.instructions).toBe("Test.");
    expect(secondGeneration.materialized?.agent?.instructions).toBe("Updated review.");
    expect(secondGeneration.materialized?.skills[0]?.instructions).toBe("Updated test.");
    expect(firstGeneration.snapshot.agents[0]?.instructionCharacters).toBe(
      firstGeneration.materialized?.agent?.instructions.length,
    );
    expect(secondGeneration.snapshot.agents[0]?.instructionCharacters).toBe(
      secondGeneration.materialized?.agent?.instructions.length,
    );
  });
});
