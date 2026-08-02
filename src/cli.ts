#!/usr/bin/env bun

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CliOptions, helpText, parseCliOptions } from "./cli-options.ts";
import { loadConfig } from "./config.ts";
import type { RouterConfig } from "./contracts.ts";
import { renderDoctorReport, runDoctor } from "./doctor.ts";
import { type OrchestratorPlanOptions, SuperRouter } from "./orchestrator.ts";
import { withTerminationSignals } from "./process-signals.ts";
import { inspectProject } from "./project-context.ts";
import { renderCapabilities, renderPlan, renderRunResult } from "./reporting.ts";
import { redactText, sanitizeTerminalText } from "./security/index.ts";
import { resolveStatePaths } from "./state-paths.ts";
import { readTelemetryStats, renderTelemetryStats } from "./stats.ts";

export const VERSION = "0.8.0";

async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseCliOptions(argv);
  if (options.command === "help") {
    writeOutput(helpText);
    return 0;
  }
  if (options.command === "version") {
    writeOutput(VERSION);
    return 0;
  }

  const cwd = resolve(options.cwd);
  const configPath = options.configPath ? resolve(cwd, options.configPath) : undefined;
  const config = effectiveConfig(loadConfig(cwd, configPath), options);

  if (options.command === "doctor") {
    const report = await runDoctor(config, cwd);
    writeOutput(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    return report.healthy ? 0 : 1;
  }
  if (options.command === "stats") {
    const project = inspectProject(cwd);
    const stats = await readTelemetryStats(
      resolveStatePaths(project.cwd, project.projectId).telemetry,
    );
    writeOutput(options.json ? JSON.stringify(stats, null, 2) : renderTelemetryStats(stats));
    return 0;
  }

  const router = new SuperRouter({
    config,
    cwd,
    trustProject: options.trustProject,
    approvalHandler: async (request) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      const prompt = [
        "\nCritical action approval required.",
        `Kind: ${request.kind}`,
        `Action: ${request.description}`,
        request.target ? `Target: ${request.target}` : undefined,
        "Approve this exact action once? [y/N] ",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await reader.question(sanitizeTerminalText(prompt));
        return /^(?:y|yes|s|sim)$/iu.test(answer.trim());
      } finally {
        reader.close();
      }
    },
  });

  if (options.command === "capabilities") {
    const snapshot = await router.capabilities();
    writeOutput(options.json ? JSON.stringify(snapshot, null, 2) : renderCapabilities(snapshot));
    return 0;
  }

  const planOptions = routingOptions(options);
  if (options.command === "plan") {
    const prepared = await router.plan(options.prompt, planOptions);
    writeOutput(options.json ? JSON.stringify(prepared, null, 2) : renderPlan(prepared.plan));
    return 0;
  }

  const execution = await withTerminationSignals(async (signal) =>
    router.run(options.prompt, { ...planOptions, signal }),
  );
  const result = execution.value;
  writeOutput(options.json ? JSON.stringify(result, null, 2) : renderRunResult(result));
  if (execution.signal) return execution.signal === "SIGINT" ? 130 : 143;
  return result.state === "verified" || result.state === "simulated" ? 0 : 2;
}

function effectiveConfig(source: RouterConfig, options: CliOptions): RouterConfig {
  return {
    ...structuredClone(source),
    ...(options.preferredProvider || options.provider
      ? { preferredProvider: options.preferredProvider ?? options.provider }
      : {}),
    qualityFloor: options.qualityFloor ?? source.qualityFloor,
    dryRun: options.dryRun || source.dryRun,
    explain: options.explain || source.explain,
    allowExternalWrites: options.allowExternalWrites || source.allowExternalWrites,
    allowDestructiveActions: options.allowDestructiveActions || source.allowDestructiveActions,
    memory: { ...source.memory, enabled: options.memoryEnabled && source.memory.enabled },
    budget: {
      ...source.budget,
      ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    },
  };
}

function routingOptions(options: CliOptions): OrchestratorPlanOptions {
  return {
    ...(options.provider ? { requiredProvider: options.provider } : {}),
    ...(options.model ? { requiredModel: options.model } : {}),
    ...(options.effort ? { requiredEffort: options.effort } : {}),
    ...(options.agent ? { requiredAgent: options.agent } : {}),
    ...(options.skills.length > 0 ? { requiredSkills: options.skills } : {}),
    ...(options.qualityFloor === undefined ? {} : { qualityFloor: options.qualityFloor }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    budget: {
      ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    },
  };
}

function writeOutput(value: string): void {
  process.stdout.write(`${sanitizeTerminalText(value)}\n`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = redactText(error instanceof Error ? error.message : String(error), {
      maxStringLength: 12_000,
    });
    process.stderr.write(`super-router: ${sanitizeTerminalText(message)}\n`);
    process.exitCode = 1;
  },
);
