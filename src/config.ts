import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Budget,
  EffortLevel,
  ModelCapability,
  RouterConfig,
  TaskIntent,
} from "./contracts.ts";

const defaultBudget: Budget = {
  maxInputTokens: 120_000,
  maxOutputTokens: 30_000,
  maxCostUsd: 10,
  maxDurationMs: 30 * 60 * 1000,
  maxAttempts: 3,
};

const MAX_CONFIG_BYTES = 1024 * 1024;
const SUPPORTS_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0;
const CONFIG_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);

const defaultModels: ModelCapability[] = [
  {
    provider: "claude-code",
    model: "haiku",
    displayName: "Claude Haiku",
    taskTypes: ["document", "test", "review", "research", "fix", "debug"],
    domains: ["general"],
    supportedEfforts: ["economy", "balanced"],
    tools: ["Read", "Glob", "Grep"],
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    qualityPrior: 0.78,
    latencyPriorMs: 4_000,
    enabled: true,
  },
  {
    provider: "claude-code",
    model: "sonnet",
    displayName: "Claude Sonnet",
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
    supportedEfforts: ["economy", "balanced", "deep"],
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Agent", "Skill"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    qualityPrior: 0.9,
    latencyPriorMs: 8_000,
    enabled: true,
  },
  {
    provider: "claude-code",
    model: "opus",
    displayName: "Claude Opus",
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
    supportedEfforts: ["balanced", "deep", "max"],
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Agent", "Skill"],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    qualityPrior: 0.97,
    latencyPriorMs: 15_000,
    enabled: true,
  },
];

const textTaskTypes: TaskIntent[] = ["review", "research", "design", "document", "security-audit"];

const anthropicApiModels: ModelCapability[] = [
  {
    provider: "anthropic-api",
    model: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5 API",
    taskTypes: textTaskTypes,
    domains: ["general"],
    supportedEfforts: ["economy", "balanced"],
    tools: [],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    qualityPrior: 0.8,
    latencyPriorMs: 4_000,
    enabled: true,
  },
  {
    provider: "anthropic-api",
    model: "claude-sonnet-5",
    displayName: "Claude Sonnet 5 API",
    taskTypes: textTaskTypes,
    domains: ["general"],
    supportedEfforts: ["economy", "balanced", "deep"],
    tools: [],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    qualityPrior: 0.94,
    latencyPriorMs: 8_000,
    enabled: true,
  },
  {
    provider: "anthropic-api",
    model: "claude-opus-4-8",
    displayName: "Claude Opus 4.8 API",
    taskTypes: textTaskTypes,
    domains: ["general"],
    supportedEfforts: ["balanced", "deep", "max"],
    tools: [],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMillion: 5,
    outputCostPerMillion: 25,
    qualityPrior: 0.98,
    latencyPriorMs: 15_000,
    enabled: true,
  },
];

const openAiApiModels: ModelCapability[] = [
  {
    provider: "openai-api",
    model: "gpt-5",
    displayName: "GPT-5 API",
    taskTypes: textTaskTypes,
    domains: ["general"],
    supportedEfforts: ["economy", "balanced", "deep"],
    tools: [],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10,
    qualityPrior: 0.92,
    latencyPriorMs: 9_000,
    enabled: true,
  },
];

export const defaultConfig: RouterConfig = {
  profile: "balanced",
  qualityFloor: 0.88,
  concurrency: 3,
  dryRun: false,
  explain: false,
  allowExternalWrites: false,
  allowDestructiveActions: false,
  memory: {
    enabled: true,
    persistRawPrompts: false,
    maxResults: 8,
  },
  telemetry: {
    enabled: true,
    includePromptHash: true,
    retentionDays: 30,
  },
  budget: defaultBudget,
  providers: [
    {
      id: "claude-code",
      enabled: true,
      transport: "cli",
      billingMode: "subscription",
      executable: "claude",
      defaultModel: "sonnet",
      models: defaultModels,
    },
    {
      id: "codex",
      enabled: false,
      transport: "cli",
      billingMode: "subscription",
      executable: "codex",
      defaultModel: "gpt-5.6-sol",
      models: [],
    },
    {
      id: "anthropic-api",
      enabled: false,
      transport: "http",
      billingMode: "metered",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      // Effort parameters are model-specific on Anthropic. Keep the default
      // catalog interoperable; trusted configs can opt in for supported models.
      sendEffort: false,
      defaultModel: "claude-sonnet-5",
      models: anthropicApiModels,
    },
    {
      id: "openai-api",
      enabled: false,
      transport: "http",
      billingMode: "metered",
      baseUrl: "https://api.openai.com",
      apiKeyEnv: "OPENAI_API_KEY",
      sendEffort: true,
      defaultModel: "gpt-5",
      models: openAiApiModels,
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOP_LEVEL_KEYS = new Set([
  "profile",
  "preferredProvider",
  "qualityFloor",
  "concurrency",
  "dryRun",
  "explain",
  "allowExternalWrites",
  "allowDestructiveActions",
  "memory",
  "telemetry",
  "budget",
  "providers",
]);
const MEMORY_KEYS = new Set(["enabled", "persistRawPrompts", "maxResults"]);
const TELEMETRY_KEYS = new Set(["enabled", "includePromptHash", "retentionDays"]);
const BUDGET_KEYS = new Set([
  "maxInputTokens",
  "maxOutputTokens",
  "maxCostUsd",
  "maxDurationMs",
  "maxAttempts",
]);
const PROVIDER_KEYS = new Set([
  "id",
  "enabled",
  "transport",
  "billingMode",
  "executable",
  "baseUrl",
  "apiKeyEnv",
  "sendEffort",
  "defaultModel",
  "models",
]);
const MODEL_KEYS = new Set([
  "provider",
  "model",
  "displayName",
  "taskTypes",
  "domains",
  "supportedEfforts",
  "tools",
  "contextWindow",
  "maxOutputTokens",
  "inputCostPerMillion",
  "outputCostPerMillion",
  "cachedInputCostPerMillion",
  "qualityPrior",
  "latencyPriorMs",
  "enabled",
]);
const PROFILES = new Set<RouterConfig["profile"]>(["economy", "balanced", "quality", "compliance"]);
const EFFORTS = new Set<EffortLevel>(["economy", "balanced", "deep", "max"]);
const INTENTS = new Set<TaskIntent>([
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
]);

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  scope: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${scope} contains unknown key(s): ${unknown.join(", ")}`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
}

function assertFiniteNumber(value: unknown, path: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${path} must be a finite number greater than or equal to ${minimum}`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must be a non-empty string`);
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
}

function assertModel(value: unknown, path: string): asserts value is ModelCapability {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertNoUnknownKeys(value, MODEL_KEYS, path);
  assertString(value.provider, `${path}.provider`);
  assertString(value.model, `${path}.model`);
  assertString(value.displayName, `${path}.displayName`);
  assertStringArray(value.taskTypes, `${path}.taskTypes`);
  if (value.taskTypes.some((intent) => !INTENTS.has(intent as TaskIntent))) {
    throw new Error(`${path}.taskTypes contains an unsupported task intent`);
  }
  assertStringArray(value.domains, `${path}.domains`);
  assertStringArray(value.supportedEfforts, `${path}.supportedEfforts`);
  if (value.supportedEfforts.some((effort) => !EFFORTS.has(effort as EffortLevel))) {
    throw new Error(`${path}.supportedEfforts contains an unsupported effort`);
  }
  assertStringArray(value.tools, `${path}.tools`);
  assertPositiveInteger(value.contextWindow, `${path}.contextWindow`);
  assertPositiveInteger(value.maxOutputTokens, `${path}.maxOutputTokens`);
  assertFiniteNumber(value.inputCostPerMillion, `${path}.inputCostPerMillion`);
  assertFiniteNumber(value.outputCostPerMillion, `${path}.outputCostPerMillion`);
  if (value.cachedInputCostPerMillion !== undefined) {
    assertFiniteNumber(value.cachedInputCostPerMillion, `${path}.cachedInputCostPerMillion`);
  }
  assertFiniteNumber(value.qualityPrior, `${path}.qualityPrior`);
  if (value.qualityPrior > 1) throw new Error(`${path}.qualityPrior cannot exceed 1`);
  assertFiniteNumber(value.latencyPriorMs, `${path}.latencyPriorMs`);
  assertBoolean(value.enabled, `${path}.enabled`);
}

function assertConfigInput(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object");
  assertNoUnknownKeys(value, TOP_LEVEL_KEYS, "configuration");
  if (value.profile !== undefined && !PROFILES.has(value.profile as RouterConfig["profile"])) {
    throw new Error("profile must be economy, balanced, quality, or compliance");
  }
  if (value.preferredProvider !== undefined) {
    assertString(value.preferredProvider, "preferredProvider");
  }
  if (value.qualityFloor !== undefined) assertFiniteNumber(value.qualityFloor, "qualityFloor");
  if (value.concurrency !== undefined) assertPositiveInteger(value.concurrency, "concurrency");
  for (const key of [
    "dryRun",
    "explain",
    "allowExternalWrites",
    "allowDestructiveActions",
  ] as const) {
    if (value[key] !== undefined) assertBoolean(value[key], key);
  }
  for (const [key, allowed] of [
    ["memory", MEMORY_KEYS],
    ["telemetry", TELEMETRY_KEYS],
    ["budget", BUDGET_KEYS],
  ] as const) {
    const nested = value[key];
    if (nested === undefined) continue;
    if (!isRecord(nested)) throw new Error(`${key} must be an object`);
    assertNoUnknownKeys(nested, allowed, key);
  }
  const memory = value.memory;
  if (isRecord(memory)) {
    if (memory.enabled !== undefined) assertBoolean(memory.enabled, "memory.enabled");
    if (memory.persistRawPrompts !== undefined) {
      assertBoolean(memory.persistRawPrompts, "memory.persistRawPrompts");
    }
    if (memory.maxResults !== undefined)
      assertPositiveInteger(memory.maxResults, "memory.maxResults");
  }
  const telemetry = value.telemetry;
  if (isRecord(telemetry)) {
    if (telemetry.enabled !== undefined) assertBoolean(telemetry.enabled, "telemetry.enabled");
    if (telemetry.includePromptHash !== undefined) {
      assertBoolean(telemetry.includePromptHash, "telemetry.includePromptHash");
    }
    if (telemetry.retentionDays !== undefined) {
      assertPositiveInteger(telemetry.retentionDays, "telemetry.retentionDays");
    }
  }
  const budget = value.budget;
  if (isRecord(budget)) {
    for (const [key, item] of Object.entries(budget)) {
      if (key === "maxAttempts") assertPositiveInteger(item, `budget.${key}`);
      else assertFiniteNumber(item, `budget.${key}`, Number.MIN_VALUE);
    }
  }
  if (value.providers !== undefined) {
    if (!Array.isArray(value.providers)) throw new Error("providers must be an array");
    for (const [index, provider] of value.providers.entries()) {
      const path = `providers[${index}]`;
      if (!isRecord(provider)) throw new Error(`${path} must be an object`);
      assertNoUnknownKeys(provider, PROVIDER_KEYS, path);
      assertString(provider.id, `${path}.id`);
      assertBoolean(provider.enabled, `${path}.enabled`);
      if (provider.transport !== "cli" && provider.transport !== "http") {
        throw new Error(`${path}.transport must be cli or http`);
      }
      if (provider.billingMode !== "subscription" && provider.billingMode !== "metered") {
        throw new Error(`${path}.billingMode must be subscription or metered`);
      }
      if (provider.transport === "cli") {
        assertString(provider.executable, `${path}.executable`);
      } else {
        assertString(provider.baseUrl, `${path}.baseUrl`);
        const url = new URL(provider.baseUrl);
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error(`${path}.baseUrl must be an HTTPS URL without credentials`);
        }
        assertString(provider.apiKeyEnv, `${path}.apiKeyEnv`);
        if (!/^[A-Z_][A-Z0-9_]*$/u.test(provider.apiKeyEnv)) {
          throw new Error(`${path}.apiKeyEnv must be an uppercase environment name`);
        }
      }
      if (provider.sendEffort !== undefined) {
        assertBoolean(provider.sendEffort, `${path}.sendEffort`);
      }
      assertString(provider.defaultModel, `${path}.defaultModel`);
      if (!Array.isArray(provider.models)) throw new Error(`${path}.models must be an array`);
      provider.models.forEach((model, modelIndex) => {
        assertModel(model, `${path}.models[${modelIndex}]`);
      });
    }
  }
}

type ConfigTrust = "trusted" | "project";

function assertProjectConfigTrustBoundary(override: Record<string, unknown>): void {
  if (Object.hasOwn(override, "providers")) {
    throw new Error(
      "Project-local configuration cannot define providers, executables, or model catalogs; use --config or SUPER_ROUTER_CONFIG for trusted provider configuration",
    );
  }
  if (override.allowExternalWrites === true) {
    throw new Error(
      "Project-local configuration cannot enable external writes; use an explicit trusted configuration or CLI authorization",
    );
  }
  if (override.allowDestructiveActions === true) {
    throw new Error(
      "Project-local configuration cannot enable destructive actions; use an explicit trusted configuration or CLI authorization",
    );
  }
  if (isRecord(override.memory) && override.memory.persistRawPrompts === true) {
    throw new Error(
      "Project-local configuration cannot enable raw prompt persistence; use --config or SUPER_ROUTER_CONFIG for trusted configuration",
    );
  }
}

function mergeConfig(
  base: RouterConfig,
  override: unknown,
  trust: ConfigTrust = "trusted",
): RouterConfig {
  assertConfigInput(override);
  if (trust === "project") assertProjectConfigTrustBoundary(override);

  const memory = isRecord(override.memory) ? override.memory : {};
  const telemetry = isRecord(override.telemetry) ? override.telemetry : {};
  const budget = isRecord(override.budget) ? override.budget : {};
  const preferredProvider =
    typeof override.preferredProvider === "string"
      ? override.preferredProvider
      : base.preferredProvider;

  return {
    profile: (override.profile as RouterConfig["profile"] | undefined) ?? base.profile,
    ...(preferredProvider ? { preferredProvider } : {}),
    qualityFloor: (override.qualityFloor as number | undefined) ?? base.qualityFloor,
    concurrency: (override.concurrency as number | undefined) ?? base.concurrency,
    dryRun: (override.dryRun as boolean | undefined) ?? base.dryRun,
    explain: (override.explain as boolean | undefined) ?? base.explain,
    allowExternalWrites:
      (override.allowExternalWrites as boolean | undefined) ?? base.allowExternalWrites,
    allowDestructiveActions:
      (override.allowDestructiveActions as boolean | undefined) ?? base.allowDestructiveActions,
    memory: { ...base.memory, ...memory } as RouterConfig["memory"],
    telemetry: { ...base.telemetry, ...telemetry } as RouterConfig["telemetry"],
    budget: { ...base.budget, ...budget } as Budget,
    providers: Array.isArray(override.providers)
      ? structuredClone(override.providers as RouterConfig["providers"])
      : structuredClone(base.providers),
  };
}

function assertConfig(config: RouterConfig): void {
  if (config.qualityFloor < 0 || config.qualityFloor > 1) {
    throw new Error("qualityFloor must be between 0 and 1");
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 16) {
    throw new Error("concurrency must be an integer between 1 and 16");
  }
  for (const [key, value] of Object.entries(config.budget)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`budget.${key} must be greater than zero`);
    }
  }
  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    if (!provider.id || providerIds.has(provider.id)) {
      throw new Error(`provider id must be unique: ${provider.id || "<empty>"}`);
    }
    providerIds.add(provider.id);
    if (provider.transport === "http" && provider.billingMode !== "metered") {
      throw new Error(`HTTP provider ${provider.id} must use metered billing`);
    }
    if (provider.transport === "cli" && (provider.baseUrl || provider.apiKeyEnv)) {
      throw new Error(`CLI provider ${provider.id} cannot define baseUrl or apiKeyEnv`);
    }
    if (provider.transport === "http" && provider.executable) {
      throw new Error(`HTTP provider ${provider.id} cannot define an executable`);
    }
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (model.provider !== provider.id) {
        throw new Error(
          `model ${model.model} provider must match its catalog provider ${provider.id}`,
        );
      }
      if (modelIds.has(model.model)) {
        throw new Error(`model id must be unique within provider ${provider.id}: ${model.model}`);
      }
      modelIds.add(model.model);
      if (model.maxOutputTokens > model.contextWindow) {
        throw new Error(`model ${provider.id}/${model.model} output limit exceeds context window`);
      }
    }
    if (provider.enabled && !provider.models.some((model) => model.enabled)) {
      throw new Error(`enabled provider ${provider.id} has no enabled models`);
    }
    if (
      provider.enabled &&
      !provider.models.some((model) => model.model === provider.defaultModel && model.enabled)
    ) {
      throw new Error(
        `provider ${provider.id} defaultModel is not present and enabled in its model catalog: ${provider.defaultModel}`,
      );
    }
  }
}

export function loadConfig(cwd = process.cwd(), explicitPath?: string): RouterConfig {
  const environmentPath = process.env.SUPER_ROUTER_CONFIG;
  const projectPath = resolve(cwd, "super-router.config.json");
  let loaded: unknown = {};
  let trust: ConfigTrust = "project";
  if (explicitPath) {
    loaded = JSON.parse(
      readRequiredConfig(explicitPath, `Configuration file does not exist: ${explicitPath}`),
    );
    trust = "trusted";
  } else if (environmentPath) {
    loaded = JSON.parse(
      readRequiredConfig(environmentPath, `SUPER_ROUTER_CONFIG does not exist: ${environmentPath}`),
    );
    trust = "trusted";
  } else {
    const projectConfig = readOptionalConfig(projectPath);
    if (projectConfig !== undefined) loaded = JSON.parse(projectConfig);
  }

  const config = mergeConfig(structuredClone(defaultConfig), loaded, trust);
  assertConfig(config);
  return config;
}

function readBoundedConfig(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, CONFIG_OPEN_FLAGS);
  } catch (error) {
    if (isNoFollowSymlinkError(error)) {
      throw new Error(
        `Configuration path must be a regular file and cannot be a symlink: ${path}`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`Configuration path is not a regular file: ${path}`);
    if (!SUPPORTS_NOFOLLOW) {
      const pathMetadata = lstatSync(path);
      if (
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        !sameFile(pathMetadata, metadata)
      ) {
        throw new Error(
          `Configuration path must be a regular file and cannot be a symlink: ${path}`,
        );
      }
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(`Configuration file exceeds the ${MAX_CONFIG_BYTES} byte limit: ${path}`);
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONFIG_BYTES) {
      throw new Error(`Configuration file exceeds the ${MAX_CONFIG_BYTES} byte limit: ${path}`);
    }
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function readRequiredConfig(path: string, missingMessage: string): string {
  try {
    return readBoundedConfig(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new Error(missingMessage, { cause: error });
    throw error;
  }
}

function readOptionalConfig(path: string): string | undefined {
  try {
    return readBoundedConfig(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNoFollowSymlinkError(error: unknown): boolean {
  return hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
