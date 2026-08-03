import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { ProviderAdapter, ProviderAvailability } from "../src/contracts.ts";
import { renderDoctorReport, runDoctor } from "../src/doctor.ts";
import { resolveStatePaths } from "../src/state-paths.ts";
import { readTelemetryStats, renderTelemetryStats } from "../src/stats.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "super-router-doctor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeAdapter(
  id: string,
  available: boolean,
  availability?: ProviderAvailability,
): ProviderAdapter {
  return {
    id,
    ...(availability ? { checkAvailability: async () => availability } : {}),
    isAvailable: async () => available,
    execute: async () => ({
      output: "not executed by doctor",
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        durationMs: 0,
      },
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operational doctor", () => {
  test("reports a healthy, verifiable workspace with an available provider", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { check: "bun test" } }),
      "utf8",
    );
    await writeFile(join(directory, "bun.lock"), "", "utf8");
    const adapters = new Map<string, ProviderAdapter>([
      ["claude-code", fakeAdapter("claude-code", true)],
    ]);

    const report = await runDoctor(structuredClone(defaultConfig), directory, { adapters });
    expect(report.healthy).toBe(true);
    expect(report.projectId).toHaveLength(24);
    expect(report.stateDirectory).toBe(resolveStatePaths(directory, report.projectId).root);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "workspace", status: "ok" }),
        expect.objectContaining({ name: "model-catalog", status: "ok" }),
        expect.objectContaining({ name: "provider:claude-code", status: "ok" }),
        expect.objectContaining({
          name: "verification",
          status: "ok",
          details: "bun run check",
        }),
        expect.objectContaining({ name: "operational-policy", status: "ok" }),
        expect.objectContaining({ name: "privacy", status: "ok" }),
      ]),
    );
    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("Super Router doctor: healthy");
    expect(rendered).toContain("[PASS] provider:claude-code");
  });

  test("makes missing adapters and unavailable runtimes fatal", async () => {
    const directory = await temporaryDirectory();
    const missing = await runDoctor(structuredClone(defaultConfig), directory, {
      adapters: new Map(),
    });
    expect(missing.healthy).toBe(false);
    expect(missing.checks).toContainEqual(
      expect.objectContaining({
        name: "provider:claude-code",
        status: "error",
        details: "No execution adapter is registered for this provider",
      }),
    );

    const unavailable = await runDoctor(structuredClone(defaultConfig), directory, {
      adapters: new Map([["claude-code", fakeAdapter("claude-code", false)]]),
    });
    expect(unavailable.healthy).toBe(false);
    expect(
      unavailable.checks.find(({ name }) => name === "provider:claude-code")?.details,
    ).toContain("not installed or runnable");

    const unauthenticated = await runDoctor(structuredClone(defaultConfig), directory, {
      adapters: new Map([
        [
          "claude-code",
          fakeAdapter("claude-code", false, {
            installed: true,
            authenticated: false,
            available: false,
          }),
        ],
      ]),
    });
    expect(unauthenticated.healthy).toBe(false);
    expect(
      unauthenticated.checks.find(({ name }) => name === "provider:claude-code")?.details,
    ).toContain("installed/configured but not authenticated");
  });

  test("warns about declared effect categories and raw-prompt settings", async () => {
    const directory = await temporaryDirectory();
    const config = structuredClone(defaultConfig);
    config.allowExternalWrites = true;
    config.allowDestructiveActions = true;
    config.memory.persistRawPrompts = true;
    const report = await runDoctor(config, directory, {
      adapters: new Map([["claude-code", fakeAdapter("claude-code", true)]]),
    });

    expect(report.healthy).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "operational-policy",
        status: "warning",
        details:
          "external category=declared; destructive category=declared; real external/destructive effects=unsupported in 0.8",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "privacy", status: "warning" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "verification", status: "warning" }),
    );
    expect(renderDoctorReport(report)).toContain("[WARN] privacy");
  });

  test("fails when no enabled model catalog exists", async () => {
    const directory = await temporaryDirectory();
    const config = structuredClone(defaultConfig);
    for (const provider of config.providers) provider.enabled = false;
    const report = await runDoctor(config, directory, { adapters: new Map() });
    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "model-catalog", status: "error" }),
    );
  });
});

describe("local telemetry statistics", () => {
  test("returns an empty report for a missing telemetry directory", async () => {
    const directory = await temporaryDirectory();
    const stats = await readTelemetryStats(join(directory, "missing"));
    expect(stats).toMatchObject({
      files: 0,
      events: 0,
      malformedLines: 0,
      runsStarted: 0,
      runsFinished: 0,
      verifiedRuns: 0,
      failedRuns: 0,
    });
    expect(stats.usage.costUsd).toBe(0);
  });

  test("reports how far the pre-run reservation was from provider-reported usage", async () => {
    // The estimator measures Super Router's own prompt; the provider also charges
    // for its system prompt, ambient instructions, files read during the turn, and
    // context resent on each turn. The gap is only knowable after the fact, so it
    // has to be recorded to be correctable.
    const directory = await temporaryDirectory();
    const telemetry = join(directory, "telemetry");
    await mkdir(telemetry);
    const lines = [
      JSON.stringify({
        type: "step.finished",
        payload: {
          usage: { inputTokens: 30_000, outputTokens: 500 },
          reservedUsage: { inputTokens: 500, outputTokens: 5_000, costUsd: 0 },
        },
      }),
      JSON.stringify({
        type: "step.finished",
        payload: {
          usage: { inputTokens: 10_000, outputTokens: 500 },
          reservedUsage: { inputTokens: 500, outputTokens: 5_000, costUsd: 0 },
        },
      }),
    ];
    await writeFile(join(telemetry, "events-2026-08-03.jsonl"), lines.join("\n"), "utf8");

    const stats = await readTelemetryStats(telemetry);
    expect(stats.reserved.inputTokens).toBe(1_000);
    expect(stats.reserved.outputTokens).toBe(10_000);
    expect(stats.stepUsage.inputTokens).toBe(40_000);
    expect(stats.stepUsage.outputTokens).toBe(1_000);

    const rendered = renderTelemetryStats(stats);
    expect(rendered).toContain("Estimate accuracy");
    // 40,000 actual against 1,000 reserved is 40x under on input.
    expect(rendered).toMatch(/input=40\.0x under/);
    // 1,000 actual against 10,000 reserved is 10x over on output.
    expect(rendered).toMatch(/output=10\.0x over/);
  });

  test("omits estimate accuracy when no step recorded a reservation", async () => {
    const directory = await temporaryDirectory();
    const telemetry = join(directory, "telemetry");
    await mkdir(telemetry);
    await writeFile(
      join(telemetry, "events-2026-08-03.jsonl"),
      JSON.stringify({ type: "step.finished", payload: { usage: { inputTokens: 10 } } }),
      "utf8",
    );
    const stats = await readTelemetryStats(telemetry);
    expect(stats.reserved.inputTokens).toBe(0);
    expect(renderTelemetryStats(stats)).not.toContain("Estimate accuracy");
  });

  test("aggregates validated run events and quarantines malformed lines", async () => {
    const directory = await temporaryDirectory();
    const telemetry = join(directory, "telemetry");
    await mkdir(telemetry);
    const lines = [
      JSON.stringify({ type: "run.started", payload: {} }),
      JSON.stringify({ type: "step.finished", payload: { usage: { inputTokens: 999 } } }),
      JSON.stringify({
        type: "run.finished",
        payload: {
          state: "verified",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            cachedInputTokens: 10,
            costUsd: 0.25,
            durationMs: 1_000,
          },
        },
      }),
      JSON.stringify({
        type: "run.finished",
        payload: {
          result: {
            state: "failed",
            usage: {
              inputTokens: 40,
              outputTokens: 10,
              reasoningTokens: -4,
              cachedInputTokens: "invalid",
              costUsd: 0.1,
              durationMs: 500,
            },
          },
        },
      }),
      "{malformed",
      "[]",
      JSON.stringify({ type: "other", payload: null }),
      "",
    ];
    await writeFile(join(telemetry, "events-2026-08-01.jsonl"), lines.join("\n"), "utf8");
    await writeFile(join(telemetry, "notes.txt"), "ignored", "utf8");

    const stats = await readTelemetryStats(telemetry);
    expect(stats).toMatchObject({
      files: 1,
      events: 5,
      malformedLines: 2,
      runsStarted: 1,
      runsFinished: 2,
      stepsFinished: 1,
      verifiedRuns: 1,
      failedRuns: 1,
    });
    expect(stats.usage).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      reasoningTokens: 5,
      cachedInputTokens: 10,
      costUsd: 0.35,
      durationMs: 1_500,
    });

    const rendered = renderTelemetryStats(stats);
    expect(rendered).toContain("Acceptance rate: 50.0%");
    expect(rendered).toContain("cost/accepted: $0.3500");
    expect(rendered).toContain("malformed=2");
  });

  test("skips oversized telemetry files before reading them", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "events-2026-08-01.jsonl"), "123456789", "utf8");
    const stats = await readTelemetryStats(directory, 4);
    expect(stats.files).toBe(0);
    expect(stats.events).toBe(0);
    expect(stats.malformedLines).toBe(1);
    expect(stats.truncated).toBe(true);
    expect(stats.filesSkipped).toBe(1);
  });

  test("bounds the aggregate number of telemetry files and reports truncation", async () => {
    const directory = await temporaryDirectory();
    const event = `${JSON.stringify({ type: "run.started", payload: {} })}\n`;
    for (const date of ["01", "02", "03"]) {
      await writeFile(join(directory, `events-2026-08-${date}.jsonl`), event, "utf8");
    }

    const stats = await readTelemetryStats(directory, 1_024, {
      maxFiles: 2,
      maxTotalBytes: 4_096,
      maxRecords: 10,
    });
    expect(stats).toMatchObject({
      files: 2,
      filesDiscovered: 3,
      filesSkipped: 1,
      recordsExamined: 2,
      events: 2,
      runsStarted: 2,
      truncated: true,
    });
    expect(stats.bytesRead).toBe(Buffer.byteLength(event) * 2);
    expect(renderTelemetryStats(stats)).toContain("truncated=true");
  });

  test("bounds aggregate telemetry bytes before allocating another file", async () => {
    const directory = await temporaryDirectory();
    const event = `${JSON.stringify({ type: "run.started", payload: { marker: "x" } })}\n`;
    await writeFile(join(directory, "events-2026-08-01.jsonl"), event, "utf8");
    await writeFile(join(directory, "events-2026-08-02.jsonl"), event, "utf8");
    const eventBytes = Buffer.byteLength(event);

    const stats = await readTelemetryStats(directory, 1_024, {
      maxFiles: 10,
      maxTotalBytes: eventBytes,
      maxRecords: 10,
    });
    expect(stats).toMatchObject({
      files: 1,
      filesDiscovered: 2,
      filesSkipped: 1,
      bytesRead: eventBytes,
      recordsExamined: 1,
      truncated: true,
    });
  });

  test("bounds aggregate parsed telemetry records", async () => {
    const directory = await temporaryDirectory();
    const lines = [
      { type: "run.started", payload: {} },
      { type: "step.finished", payload: {} },
      { type: "run.finished", payload: { state: "verified" } },
    ].map((event) => JSON.stringify(event));
    await writeFile(join(directory, "events-2026-08-01.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const stats = await readTelemetryStats(directory, 4_096, {
      maxFiles: 10,
      maxTotalBytes: 4_096,
      maxRecords: 2,
    });
    expect(stats).toMatchObject({
      files: 1,
      filesDiscovered: 1,
      filesSkipped: 0,
      recordsExamined: 2,
      events: 2,
      runsStarted: 1,
      stepsFinished: 1,
      runsFinished: 0,
      truncated: true,
    });
  });

  test("rejects aggregate telemetry limits that could disable bounds", async () => {
    const directory = await temporaryDirectory();
    await expect(readTelemetryStats(directory, 0)).rejects.toThrow("maxFileBytes");
    await expect(
      readTelemetryStats(directory, 1_024, { maxFiles: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow("maxFiles");
  });
});

describe("state path isolation", () => {
  test("keeps memory and telemetry in a trusted project namespace outside the repository", () => {
    const previous = process.env.SUPER_ROUTER_STATE_DIR;
    process.env.SUPER_ROUTER_STATE_DIR = "/trusted/state";
    try {
      expect(resolveStatePaths("/workspace/project", "project-id")).toEqual({
        root: resolve("/trusted/state/super-router/projects/project-id"),
        memory: resolve("/trusted/state/super-router/projects/project-id/memory"),
        telemetry: resolve("/trusted/state/super-router/projects/project-id/telemetry"),
      });
    } finally {
      if (previous === undefined) delete process.env.SUPER_ROUTER_STATE_DIR;
      else process.env.SUPER_ROUTER_STATE_DIR = previous;
    }
  });

  test("rejects project namespaces that could escape the trusted state root", () => {
    expect(() => resolveStatePaths("/workspace", "../../outside")).toThrow(
      "filesystem-safe identifier",
    );
  });
});
