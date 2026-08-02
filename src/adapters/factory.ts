import type { ProviderAdapter, RouterConfig } from "../contracts.ts";
import { AnthropicApiAdapter } from "./anthropic-api.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";
import { DryRunAdapter } from "./dry-run.ts";
import { OpenAIApiAdapter } from "./openai-api.ts";
import type { ProcessRunner } from "./process-runner.ts";

export interface AdapterFactoryOptions {
  runners?: Readonly<Record<string, ProcessRunner>>;
  includeDryRun?: boolean;
}

export function createProviderAdapters(
  config: RouterConfig,
  options: AdapterFactoryOptions = {},
): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = [];
  for (const provider of config.providers.filter((candidate) => candidate.enabled)) {
    if (provider.id === "claude-code") {
      if (!provider.executable) throw new Error("claude-code requires an executable");
      adapters.push(
        new ClaudeCodeAdapter({
          executable: provider.executable,
          models: provider.models,
          meteredBilling: provider.billingMode === "metered",
          ...(options.runners?.[provider.id] ? { runner: options.runners[provider.id] } : {}),
        }),
      );
    } else if (provider.id === "codex") {
      if (!provider.executable) throw new Error("codex requires an executable");
      adapters.push(
        new CodexAdapter({
          executable: provider.executable,
          models: provider.models,
          meteredBilling: provider.billingMode === "metered",
          ...(options.runners?.[provider.id] ? { runner: options.runners[provider.id] } : {}),
        }),
      );
    } else if (provider.id === "anthropic-api") {
      adapters.push(
        new AnthropicApiAdapter({
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
          models: provider.models,
          includeEffort: provider.sendEffort ?? true,
        }),
      );
    } else if (provider.id === "openai-api") {
      adapters.push(
        new OpenAIApiAdapter({
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
          models: provider.models,
          includeReasoningEffort: provider.sendEffort ?? true,
        }),
      );
    }
  }
  if (options.includeDryRun ?? config.dryRun) adapters.push(new DryRunAdapter());
  return adapters;
}
