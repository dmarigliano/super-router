import { access, constants, stat } from "node:fs/promises";
import { createProviderAdapters } from "./adapters/index.ts";
import type { ProviderAdapter, ProviderAvailability, RouterConfig } from "./contracts.ts";
import { inspectProject } from "./project-context.ts";
import { resolveStatePaths } from "./state-paths.ts";

export type DoctorStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  details: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
  projectId: string;
  stateDirectory: string;
}

export interface DoctorOptions {
  adapters?: ReadonlyMap<string, ProviderAdapter>;
}

function createAdapters(config: RouterConfig): Map<string, ProviderAdapter> {
  return new Map(
    createProviderAdapters(config, { includeDryRun: false }).map((adapter) => [
      adapter.id,
      adapter,
    ]),
  );
}

export async function runDoctor(
  config: RouterConfig,
  cwd: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const project = inspectProject(cwd);
  const paths = resolveStatePaths(project.cwd, project.projectId);

  try {
    const metadata = await stat(project.cwd);
    await access(project.cwd, constants.R_OK | constants.W_OK);
    checks.push({
      name: "workspace",
      status: metadata.isDirectory() ? "ok" : "error",
      details: metadata.isDirectory()
        ? `Readable and writable: ${project.cwd}`
        : `Not a directory: ${project.cwd}`,
    });
  } catch (error) {
    checks.push({
      name: "workspace",
      status: "error",
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const enabledProviders = config.providers.filter((provider) => provider.enabled);
  checks.push({
    name: "model-catalog",
    status:
      enabledProviders.length > 0 && enabledProviders.some(({ models }) => models.length > 0)
        ? "ok"
        : "error",
    details: `${enabledProviders.length} enabled provider(s), ${enabledProviders.reduce(
      (total, provider) => total + provider.models.filter((model) => model.enabled).length,
      0,
    )} enabled model(s)`,
  });

  const adapters = options.adapters ?? createAdapters(config);
  for (const provider of enabledProviders) {
    const adapter = adapters.get(provider.id);
    if (!adapter) {
      checks.push({
        name: `provider:${provider.id}`,
        status: "error",
        details: "No execution adapter is registered for this provider",
      });
      continue;
    }
    const availability = await inspectAdapterAvailability(adapter);
    const target = provider.executable ?? provider.baseUrl ?? provider.id;
    checks.push({
      name: `provider:${provider.id}`,
      status: availability.available ? "ok" : "error",
      details: availability.available
        ? `Runtime is installed/configured and authenticated (${target})`
        : availability.installed
          ? `Runtime is installed/configured but not authenticated (${target})`
          : `Runtime is not installed or runnable (${target})`,
    });
  }

  checks.push({
    name: "verification",
    status: project.verificationCommands.length > 0 ? "ok" : "warning",
    details:
      project.verificationCommands.length > 0
        ? project.verificationCommands.join(", ")
        : "No deterministic project checks were discovered",
  });
  checks.push({
    name: "operational-policy",
    status: config.allowExternalWrites || config.allowDestructiveActions ? "warning" : "ok",
    details: `external category=${config.allowExternalWrites ? "declared" : "not declared"}; destructive category=${
      config.allowDestructiveActions ? "declared" : "not declared"
    }; real external/destructive effects=unsupported in 0.8`,
  });
  checks.push({
    name: "privacy",
    status: config.memory.persistRawPrompts ? "warning" : "ok",
    details: config.memory.persistRawPrompts
      ? "Trusted raw-prompt persistence is enabled; provider-reflected task text may enter local memory"
      : "Task text reflected by providers is omitted from memory; telemetry free-form strings are omitted",
  });

  return {
    healthy: checks.every((check) => check.status !== "error"),
    checks,
    projectId: project.projectId,
    stateDirectory: paths.root,
  };
}

async function inspectAdapterAvailability(adapter: ProviderAdapter): Promise<ProviderAvailability> {
  try {
    if (adapter.checkAvailability) return await adapter.checkAvailability();
    const available = await adapter.isAvailable();
    return { installed: available, authenticated: available, available };
  } catch {
    return { installed: false, authenticated: false, available: false };
  }
}

export function renderDoctorReport(report: DoctorReport): string {
  const icon: Readonly<Record<DoctorStatus, string>> = {
    ok: "PASS",
    warning: "WARN",
    error: "FAIL",
  };
  return [
    `Super Router doctor: ${report.healthy ? "healthy" : "unhealthy"}`,
    `Project: ${report.projectId}`,
    `State: ${report.stateDirectory}`,
    "",
    ...report.checks.map((check) => `[${icon[check.status]}] ${check.name}: ${check.details}`),
  ].join("\n");
}
