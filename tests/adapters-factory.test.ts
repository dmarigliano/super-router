import { describe, expect, test } from "bun:test";
import { createProviderAdapters } from "../src/adapters/factory.ts";
import type { ProcessResult, ProcessRunner } from "../src/adapters/process-runner.ts";
import { defaultConfig } from "../src/config.ts";
import type { ProviderConfig, RouterConfig } from "../src/contracts.ts";

function processResult(stdout = ""): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false };
}

function configWithProviders(providers: ProviderConfig[], dryRun = false): RouterConfig {
  return { ...structuredClone(defaultConfig), providers, dryRun };
}

function provider(overrides: Partial<ProviderConfig> & { id: string }): ProviderConfig {
  const template = structuredClone(defaultConfig.providers[0]);
  if (!template) throw new Error("default provider fixture is missing");
  return { ...template, ...overrides };
}

const noopRunner: ProcessRunner = { run: async () => processResult() };

describe("provider adapter factory", () => {
  test("builds an adapter only for each enabled provider", () => {
    const adapters = createProviderAdapters(
      configWithProviders([
        provider({ id: "claude-code", enabled: true, executable: "claude" }),
        provider({ id: "codex", enabled: false, executable: "codex" }),
      ]),
    );
    expect(adapters.map((adapter) => adapter.id)).toEqual(["claude-code"]);
  });

  test("builds every supported provider id", () => {
    const adapters = createProviderAdapters(
      configWithProviders([
        provider({ id: "claude-code", enabled: true, executable: "claude" }),
        provider({ id: "codex", enabled: true, executable: "codex" }),
        provider({ id: "anthropic-api", enabled: true, transport: "http", billingMode: "metered" }),
        provider({ id: "openai-api", enabled: true, transport: "http", billingMode: "metered" }),
      ]),
    );
    expect(adapters.map((adapter) => adapter.id).sort()).toEqual([
      "anthropic-api",
      "claude-code",
      "codex",
      "openai-api",
    ]);
  });

  test.each(["claude-code", "codex"] as const)(
    "refuses to build %s without an executable",
    (id) => {
      const candidate = provider({ id, enabled: true });
      delete candidate.executable;
      expect(() => createProviderAdapters(configWithProviders([candidate]))).toThrow(
        `${id} requires an executable`,
      );
    },
  );

  test("skips an enabled provider that has no registered adapter", () => {
    // The router reports the missing adapter through doctor and refuses the route
    // at execution. The factory must not invent one or throw here, or an
    // otherwise usable catalog would fail to load.
    const adapters = createProviderAdapters(
      configWithProviders([
        provider({ id: "unregistered-provider", enabled: true, executable: "/bin/sh" }),
        provider({ id: "claude-code", enabled: true, executable: "claude" }),
      ]),
    );
    expect(adapters.map((adapter) => adapter.id)).toEqual(["claude-code"]);
  });

  test("appends the dry-run adapter from config and from the explicit option", () => {
    const providers = [provider({ id: "claude-code", enabled: true, executable: "claude" })];
    expect(
      createProviderAdapters(configWithProviders(providers, true)).map((adapter) => adapter.id),
    ).toContain("dry-run");
    expect(
      createProviderAdapters(configWithProviders(providers, false), {
        includeDryRun: true,
      }).map((adapter) => adapter.id),
    ).toContain("dry-run");
    expect(
      createProviderAdapters(configWithProviders(providers, true), {
        includeDryRun: false,
      }).map((adapter) => adapter.id),
    ).not.toContain("dry-run");
  });

  test("returns only the dry-run adapter when no provider is enabled", () => {
    expect(createProviderAdapters(configWithProviders([], true)).map((a) => a.id)).toEqual([
      "dry-run",
    ]);
    expect(createProviderAdapters(configWithProviders([], false))).toEqual([]);
  });

  test("routes each injected runner to its own provider", async () => {
    // Availability is more than one probe per CLI adapter (install, then auth), so
    // this pins which runner receives the calls, not how many there are.
    const seen: Record<string, string[]> = { codex: [], "claude-code": [] };
    const recorder = (key: string): ProcessRunner => ({
      run: async (invocation) => {
        seen[key]?.push(invocation.executable);
        return processResult("{}");
      },
    });
    const adapters = createProviderAdapters(
      configWithProviders([
        provider({ id: "claude-code", enabled: true, executable: "claude" }),
        provider({ id: "codex", enabled: true, executable: "codex" }),
      ]),
      { runners: { codex: recorder("codex"), "claude-code": recorder("claude-code") } },
    );

    const codex = adapters.find((adapter) => adapter.id === "codex");
    if (!codex) throw new Error("codex adapter was not built");
    await codex.isAvailable();

    expect(seen.codex?.length).toBeGreaterThan(0);
    expect(new Set(seen.codex)).toEqual(new Set(["codex"]));
    expect(seen["claude-code"]).toEqual([]);
  });

  test("falls back to the default runner when none is injected for a provider", async () => {
    const adapters = createProviderAdapters(
      configWithProviders([provider({ id: "codex", enabled: true, executable: "codex" })]),
      { runners: { "claude-code": noopRunner } },
    );
    const codex = adapters.find((adapter) => adapter.id === "codex");
    if (!codex) throw new Error("codex adapter was not built");
    // No injected runner for codex, so it uses SpawnProcessRunner against an
    // executable that is absent here. That must resolve to false, not reject.
    expect(await codex.isAvailable()).toBe(false);
  });
});
