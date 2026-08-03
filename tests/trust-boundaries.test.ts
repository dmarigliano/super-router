import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { discoverCapabilities } from "../src/routing/capability-registry.ts";

const temporaryDirectories: string[] = [];
const originalConfigEnvironment = process.env.SUPER_ROUTER_CONFIG;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value)}\n`);
}

afterEach(async () => {
  if (originalConfigEnvironment === undefined) delete process.env.SUPER_ROUTER_CONFIG;
  else process.env.SUPER_ROUTER_CONFIG = originalConfigEnvironment;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project-local configuration trust boundary", () => {
  test("rejects project attempts to expand execution or data authority", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory("super-router-project-config-");
    const path = join(directory, "super-router.config.json");
    const provider = structuredClone(defaultConfig.providers[0]);
    if (!provider) throw new Error("default provider fixture is missing");
    provider.executable = "./repository-controlled-payload";

    const cases: Array<[unknown, string]> = [
      [
        { providers: [provider] },
        "Project-local configuration cannot define providers, executables, or model catalogs",
      ],
      [{ allowExternalWrites: true }, "Project-local configuration cannot enable external writes"],
      [
        { allowDestructiveActions: true },
        "Project-local configuration cannot enable destructive actions",
      ],
      [
        { memory: { persistRawPrompts: true } },
        "Project-local configuration cannot enable raw prompt persistence",
      ],
      // Silencing the audit trail is authority over evidence, not a routing
      // preference: an untrusted checkout could install NullTelemetry for every
      // run in it while doctor still reported telemetry as active.
      [
        { telemetry: { enabled: false } },
        "Project-local configuration cannot disable telemetry or memory",
      ],
      [
        { memory: { enabled: false } },
        "Project-local configuration cannot disable telemetry or memory",
      ],
    ];

    for (const [value, message] of cases) {
      await writeJson(path, value);
      expect(() => loadConfig(directory)).toThrow(message);
    }
  });

  test("allows bounded project preferences without changing trusted providers", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory("super-router-safe-project-config-");
    await writeJson(join(directory, "super-router.config.json"), {
      profile: "economy",
      allowExternalWrites: false,
      allowDestructiveActions: false,
      memory: { persistRawPrompts: false, maxResults: 2 },
      budget: { maxCostUsd: 0.5 },
    });

    const config = loadConfig(directory);
    expect(config.profile).toBe("economy");
    expect(config.budget.maxCostUsd).toBe(0.5);
    expect(config.memory.maxResults).toBe(2);
    expect(config.providers).toEqual(defaultConfig.providers);
    expect(config.allowExternalWrites).toBe(false);
    expect(config.allowDestructiveActions).toBe(false);
    expect(config.memory.persistRawPrompts).toBe(false);
  });

  test("keeps explicit and environment configuration as trusted sources", async () => {
    const directory = await temporaryDirectory("super-router-trusted-config-");
    const provider = structuredClone(defaultConfig.providers[0]);
    if (!provider) throw new Error("default provider fixture is missing");
    provider.executable = "/trusted/provider-runtime";
    const explicitPath = join(directory, "explicit.json");
    await writeJson(explicitPath, {
      providers: [provider],
      allowExternalWrites: true,
      allowDestructiveActions: true,
      memory: { persistRawPrompts: true },
    });

    const explicit = loadConfig(directory, explicitPath);
    expect(explicit.providers[0]?.executable).toBe("/trusted/provider-runtime");
    expect(explicit.allowExternalWrites).toBe(true);
    expect(explicit.allowDestructiveActions).toBe(true);
    expect(explicit.memory.persistRawPrompts).toBe(true);

    const environmentPath = join(directory, "environment.json");
    await writeJson(environmentPath, {
      allowExternalWrites: true,
      memory: { persistRawPrompts: true },
    });
    process.env.SUPER_ROUTER_CONFIG = environmentPath;
    const environment = loadConfig(directory);
    expect(environment.allowExternalWrites).toBe(true);
    expect(environment.memory.persistRawPrompts).toBe(true);
  });
});

describe("project capability trust boundary", () => {
  test("caps project trust and namespaces collisions in favor of user capabilities", async () => {
    const cwd = await temporaryDirectory("super-router-project-capabilities-");
    const homeDir = await temporaryDirectory("super-router-user-capabilities-");

    await writeText(
      join(cwd, ".claude/agents/reviewer.md"),
      `---
name: reviewer
description: Project-controlled reviewer
risk-ceiling: critical
---
Project instructions.
`,
    );
    await writeText(
      join(homeDir, ".claude/agents/reviewer.md"),
      `---
name: reviewer
description: User-controlled reviewer
risk-ceiling: critical
---
User instructions.
`,
    );
    await writeText(
      join(cwd, ".claude/agents/project-only.md"),
      `---
name: project-only
description: Project-only agent
risk-ceiling: high
---
Project instructions.
`,
    );
    await writeText(
      join(cwd, ".claude/skills/secure/SKILL.md"),
      `---
name: secure
description: Project-controlled skill
trusted: true
---
Project instructions.
`,
    );
    await writeText(
      join(homeDir, ".claude/skills/secure/SKILL.md"),
      `---
name: secure
description: User-controlled skill
trusted: false
---
User instructions.
`,
    );
    await writeText(
      join(cwd, ".claude/skills/project-only/SKILL.md"),
      `---
name: project-only
description: Project-only skill
trusted: true
---
Project instructions.
`,
    );

    const snapshot = await discoverCapabilities(defaultConfig, { cwd, homeDir });

    expect(snapshot.agents.find(({ id }) => id === "reviewer")).toMatchObject({
      description: "User-controlled reviewer",
      riskCeiling: "critical",
    });
    expect(snapshot.agents.find(({ id }) => id === "project:reviewer")).toMatchObject({
      description: "Project-controlled reviewer",
      riskCeiling: "medium",
      providers: ["claude-code"],
      enabled: false,
    });
    expect(snapshot.agents.find(({ id }) => id === "project-only")?.riskCeiling).toBe("medium");

    expect(snapshot.skills.find(({ id }) => id === "secure")).toMatchObject({
      description: "User-controlled skill",
      trusted: true,
    });
    expect(snapshot.skills.find(({ id }) => id === "project:secure")).toMatchObject({
      description: "Project-controlled skill",
      trusted: false,
      providers: ["claude-code"],
      enabled: false,
    });
    expect(snapshot.skills.find(({ id }) => id === "project-only")?.trusted).toBe(false);
  });

  test("does not grant trust to an explicitly selected root from manifest frontmatter", async () => {
    const root = await temporaryDirectory("super-router-explicit-capabilities-");
    await writeText(
      join(root, "self-trusted/SKILL.md"),
      `---
name: self-trusted
description: Explicitly discovered skill
trusted: true
---
Instructions.
`,
    );

    const snapshot = await discoverCapabilities(defaultConfig, {
      skillRoots: [root],
      includeProjectRoots: false,
      includeUserRoots: false,
    });

    expect(snapshot.skills.find(({ id }) => id === "self-trusted")?.trusted).toBe(false);
  });
});
