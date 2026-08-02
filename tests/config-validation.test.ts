import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../src/config.ts";

const temporaryDirectories: string[] = [];
const originalConfigEnvironment = process.env.SUPER_ROUTER_CONFIG;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "super-router-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
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

describe("configuration loading and precedence", () => {
  test("rejects oversized and symlinked configuration files before parsing", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const projectPath = join(directory, "super-router.config.json");
    await writeFile(projectPath, "x".repeat(1024 * 1024 + 1), "utf8");
    expect(() => loadConfig(directory)).toThrow("exceeds the 1048576 byte limit");

    await rm(projectPath);
    const target = await writeJson(directory, "target.json", { profile: "economy" });
    await symlink(target, projectPath);
    expect(() => loadConfig(directory)).toThrow("cannot be a symlink");
  });

  test("returns an isolated clone of secure defaults", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const first = loadConfig(directory);
    first.budget.maxCostUsd = 999;
    first.providers[0]?.models.splice(0);

    const second = loadConfig(directory);
    expect(second.budget.maxCostUsd).toBe(defaultConfig.budget.maxCostUsd);
    expect(second.providers[0]?.models.length).toBeGreaterThan(0);
    expect(second.allowExternalWrites).toBe(false);
    expect(second.allowDestructiveActions).toBe(false);
  });

  test("uses explicit path before environment path before project-local config", async () => {
    const directory = await temporaryDirectory();
    await writeJson(directory, "super-router.config.json", { profile: "economy" });
    const environmentPath = await writeJson(directory, "environment.json", {
      profile: "balanced",
    });
    const explicitPath = await writeJson(directory, "explicit.json", { profile: "quality" });
    process.env.SUPER_ROUTER_CONFIG = environmentPath;

    expect(loadConfig(directory, explicitPath).profile).toBe("quality");
    expect(loadConfig(directory).profile).toBe("balanced");
    delete process.env.SUPER_ROUTER_CONFIG;
    expect(loadConfig(directory).profile).toBe("economy");
  });

  test("deep-merges bounded nested settings without erasing defaults", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    await writeJson(directory, "super-router.config.json", {
      preferredProvider: "claude-code",
      memory: { maxResults: 3 },
      telemetry: { retentionDays: 7 },
      budget: { maxCostUsd: 0.5, maxAttempts: 1 },
    });

    const config = loadConfig(directory);
    expect(config.preferredProvider).toBe("claude-code");
    expect(config.memory).toEqual({
      enabled: true,
      persistRawPrompts: false,
      maxResults: 3,
    });
    expect(config.telemetry).toEqual({
      enabled: true,
      includePromptHash: true,
      retentionDays: 7,
    });
    expect(config.budget.maxCostUsd).toBe(0.5);
    expect(config.budget.maxAttempts).toBe(1);
    expect(config.budget.maxInputTokens).toBe(defaultConfig.budget.maxInputTokens);
  });

  test("replaces the provider catalog only when providers are explicitly supplied", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const provider = structuredClone(defaultConfig.providers[0]);
    const baseModel = provider?.models[0];
    if (!provider || !baseModel) throw new Error("default provider fixture is missing");
    provider.id = "private-runtime";
    provider.defaultModel = "economical";
    provider.models = [
      {
        ...baseModel,
        provider: "private-runtime",
        model: "economical",
      },
    ];
    const trustedPath = await writeJson(directory, "trusted-config.json", {
      providers: [provider],
    });

    const config = loadConfig(directory, trustedPath);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.id).toBe("private-runtime");
    expect(config.providers[0]?.models[0]?.model).toBe("economical");
  });

  test("reports missing explicit and environment configuration paths", async () => {
    const directory = await temporaryDirectory();
    const missingExplicit = join(directory, "missing-explicit.json");
    expect(() => loadConfig(directory, missingExplicit)).toThrow(
      `Configuration file does not exist: ${missingExplicit}`,
    );

    const missingEnvironment = join(directory, "missing-environment.json");
    process.env.SUPER_ROUTER_CONFIG = missingEnvironment;
    expect(() => loadConfig(directory)).toThrow(
      `SUPER_ROUTER_CONFIG does not exist: ${missingEnvironment}`,
    );
  });
});

describe("configuration validation", () => {
  test.each([
    [{ mystery: true }, "unknown key(s): mystery"],
    [{ profile: "turbo" }, "profile must be economy"],
    [{ qualityFloor: 1.01 }, "qualityFloor must be between 0 and 1"],
    [{ concurrency: 17 }, "concurrency must be an integer between 1 and 16"],
    [{ concurrency: 1.5 }, "concurrency must be a positive integer"],
    [{ memory: { maxResults: 0 } }, "memory.maxResults must be a positive integer"],
    [{ telemetry: { rawPrompts: true } }, "telemetry contains unknown key(s)"],
    [{ budget: { maxCostUsd: 0 } }, "budget.maxCostUsd must be a finite number"],
    [{ budget: { maxAttempts: 1.5 } }, "budget.maxAttempts must be a positive integer"],
  ] as const)("rejects malformed config %o", async (input, message) => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    await writeJson(directory, "super-router.config.json", input);
    expect(() => loadConfig(directory)).toThrow(message);
  });

  test("rejects duplicate providers and a missing enabled default model", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const provider = structuredClone(defaultConfig.providers[0]);
    if (!provider) throw new Error("default provider fixture is missing");
    const trustedPath = await writeJson(directory, "trusted-config.json", {
      providers: [provider, provider],
    });
    expect(() => loadConfig(directory, trustedPath)).toThrow("provider id must be unique");

    provider.id = "missing-default";
    provider.models = provider.models.map((model) => ({ ...model, provider: provider.id }));
    provider.defaultModel = "not-in-catalog";
    await writeJson(directory, "trusted-config.json", { providers: [provider] });
    expect(() => loadConfig(directory, trustedPath)).toThrow(
      "defaultModel is not present and enabled",
    );
  });

  test("rejects inconsistent provider transports and model catalogs", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const provider = structuredClone(defaultConfig.providers[0]);
    const model = provider?.models[0];
    if (!provider || !model) throw new Error("default provider fixture is missing");
    const trustedPath = join(directory, "trusted-config.json");

    provider.baseUrl = "https://example.com";
    await writeJson(directory, "trusted-config.json", { providers: [provider] });
    expect(() => loadConfig(directory, trustedPath)).toThrow("cannot define baseUrl");

    delete provider.baseUrl;
    model.provider = "different-provider";
    await writeJson(directory, "trusted-config.json", { providers: [provider] });
    expect(() => loadConfig(directory, trustedPath)).toThrow("must match its catalog provider");

    model.provider = provider.id;
    provider.transport = "http";
    provider.billingMode = "subscription";
    delete provider.executable;
    provider.baseUrl = "https://example.com";
    provider.apiKeyEnv = "EXAMPLE_API_KEY";
    await writeJson(directory, "trusted-config.json", { providers: [provider] });
    expect(() => loadConfig(directory, trustedPath)).toThrow("must use metered billing");
  });

  test("validates every model field and enum", async () => {
    delete process.env.SUPER_ROUTER_CONFIG;
    const directory = await temporaryDirectory();
    const provider = structuredClone(defaultConfig.providers[0]);
    const model = provider?.models[0];
    if (!provider || !model) throw new Error("default model fixture is missing");
    model.taskTypes = ["invent" as never];
    const trustedPath = await writeJson(directory, "trusted-config.json", {
      providers: [provider],
    });
    expect(() => loadConfig(directory, trustedPath)).toThrow("unsupported task intent");

    model.taskTypes = ["implement"];
    model.supportedEfforts = ["impossible" as never];
    await writeJson(directory, "trusted-config.json", { providers: [provider] });
    expect(() => loadConfig(directory, trustedPath)).toThrow("unsupported effort");

    model.supportedEfforts = ["balanced"];
    model.qualityPrior = 1.1;
    await writeJson(directory, "super-router.config.json", { providers: [provider] });
    expect(() => loadConfig(directory)).toThrow("qualityPrior cannot exceed 1");
  });
});
