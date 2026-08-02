import { type Dirent, constants as fsConstants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, sep as pathSeparator, relative, resolve } from "node:path";
import type {
  AgentCapability,
  CapabilitySnapshot,
  MaterializedRouteCapabilities,
  ModelCapability,
  RiskLevel,
  RouteDecision,
  RouterConfig,
  SkillCapability,
  TaskIntent,
} from "../contracts.ts";
import { tokenizePrompt } from "../intake/classifier.ts";
import { estimateTokens, stableHash } from "../utils.ts";
import {
  type CapabilityInstructionCatalog,
  MAX_CAPABILITY_INSTRUCTION_CHARACTERS,
  materializeRouteCapabilities,
} from "./capability-materialization.ts";
import { capabilitySupportsProvider } from "./provider-scope.ts";

export interface CapabilityDiscoveryOptions {
  cwd?: string;
  homeDir?: string;
  agentRoots?: string[];
  skillRoots?: string[];
  includeProjectRoots?: boolean;
  includeUserRoots?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  /** May reduce, but never exceed, the shared directory-entry traversal budget. */
  maxEntries?: number;
  /** May reduce, but never exceed, the shared 32 MiB discovery read budget. */
  maxBytes?: number;
}

interface ParsedManifest {
  attributes: Record<string, string | string[]>;
  body: string;
  bodyComplete: boolean;
}

type CapabilityOrigin = "explicit" | "project" | "user";

interface DiscoveryRoot {
  path: string;
  origin: CapabilityOrigin;
  providers?: string[];
  /** Project roots must remain canonically contained by this directory. */
  boundary?: string;
}

interface DiscoveryRoots {
  agentRoots: DiscoveryRoot[];
  skillRoots: DiscoveryRoot[];
}

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_DISCOVERY_BYTES = 32 * 1_048_576;
const MAX_DISCOVERY_FILES = 4_000;
const MAX_DISCOVERY_ENTRIES = 20_000;
const MAX_DISCOVERY_ROOTS = 64;
const MAX_FRONTMATTER_LINES = 512;
const MAX_METADATA_KEYS = 64;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_CHARACTERS = 128;
const MAX_SCALAR_CHARACTERS = 512;
const MAX_DESCRIPTION_CHARACTERS = 500;
const MAX_BODY_CHARACTERS = MAX_CAPABILITY_INSTRUCTION_CHARACTERS;
const CAPABILITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

interface DiscoveryBudget {
  files: number;
  entries: number;
  bytes: number;
}

interface DiscoveredCapability<T extends { id: string }> {
  capability: T;
  origin: CapabilityOrigin;
  instructions?: string;
}

interface DiscoveredCapabilityCatalog {
  snapshot: CapabilitySnapshot;
  instructions: CapabilityInstructionCatalog;
}

export interface RouteCapabilityGeneration {
  snapshot: CapabilitySnapshot;
  materialized?: MaterializedRouteCapabilities;
  materializationError?: string;
}

const TASK_TYPES: readonly TaskIntent[] = [
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
];

const DOMAIN_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  security: [
    "security",
    "secure",
    "auth",
    "authentication",
    "authorization",
    "vulnerability",
    "seguranca",
    "seguridad",
  ],
  frontend: ["frontend", "react", "vue", "svelte", "css", "browser", "interface"],
  backend: ["backend", "server", "api", "endpoint", "service", "servidor"],
  database: ["database", "sql", "postgres", "mysql", "schema", "migration", "dados"],
  devops: ["devops", "pipeline", "docker", "kubernetes", "deployment", "deploy"],
  testing: ["test", "tests", "testing", "coverage", "teste", "prueba"],
  documentation: ["documentation", "docs", "readme", "guide", "documentacao"],
  performance: ["performance", "latency", "benchmark", "memory", "tokens", "desempenho"],
  data: ["data", "analytics", "dataset", "etl", "metrics", "dados"],
  ai: ["ai", "llm", "model", "prompt", "agent", "skill", "ia"],
  mobile: ["mobile", "ios", "android", "swift", "kotlin"],
};

function unique(values: readonly string[]): string[] {
  const bounded = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= MAX_LIST_ITEM_CHARACTERS);
  return [...new Set(bounded)].slice(0, MAX_LIST_ITEMS);
}

function parseScalar(value: string): string | string[] {
  const trimmed = value.trim().replace(/^['"]|['"]$/gu, "");
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return unique(
      trimmed
        .slice(1, -1)
        .split(",", MAX_LIST_ITEMS)
        .map((entry) => entry.replace(/^['"]|['"]$/gu, "")),
    );
  }
  return trimmed.slice(0, MAX_SCALAR_CHARACTERS);
}

function parseManifest(content: string): ParsedManifest {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      attributes: {},
      body: normalized.slice(0, MAX_BODY_CHARACTERS),
      bodyComplete: normalized.length <= MAX_BODY_CHARACTERS,
    };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    return {
      attributes: {},
      body: normalized.slice(0, MAX_BODY_CHARACTERS),
      bodyComplete: normalized.length <= MAX_BODY_CHARACTERS,
    };
  }

  const attributes: Record<string, string | string[]> = {};
  const lines = normalized.slice(4, end).split("\n", MAX_FRONTMATTER_LINES);
  let listKey: string | undefined;
  for (const line of lines) {
    const listEntry = line.match(/^\s*-\s+(.+)$/u);
    if (listEntry?.[1] && listKey) {
      const existing = attributes[listKey];
      const values = Array.isArray(existing) ? existing : [];
      const value = listEntry[1].trim().replace(/^['"]|['"]$/gu, "");
      if (values.length < MAX_LIST_ITEMS && value.length <= MAX_LIST_ITEM_CHARACTERS) {
        values.push(value);
      }
      attributes[listKey] = values;
      continue;
    }
    const property = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/u);
    if (!property?.[1]) continue;
    const key = property[1].toLocaleLowerCase("en-US");
    if (!(key in attributes) && Object.keys(attributes).length >= MAX_METADATA_KEYS) continue;
    const value = property[2] ?? "";
    if (!value.trim()) {
      attributes[key] = [];
      listKey = key;
    } else {
      attributes[key] = parseScalar(value);
      listKey = undefined;
    }
  }
  const completeBody = normalized.slice(end + 4).trim();
  return {
    attributes,
    body: completeBody.slice(0, MAX_BODY_CHARACTERS),
    bodyComplete: completeBody.length <= MAX_BODY_CHARACTERS,
  };
}

function attribute(manifest: ParsedManifest, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = manifest.attributes[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function attributeList(manifest: ParsedManifest, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = manifest.attributes[key];
    if (Array.isArray(value)) return unique(value);
    if (typeof value === "string") return unique(value.split(/[,\s]+/u, MAX_LIST_ITEMS));
  }
  return [];
}

function attributeBoolean(manifest: ParsedManifest, key: string, fallback: boolean): boolean {
  const value = manifest.attributes[key];
  if (typeof value !== "string") return fallback;
  if (["true", "yes", "1", "enabled"].includes(value.toLocaleLowerCase("en-US"))) return true;
  if (["false", "no", "0", "disabled"].includes(value.toLocaleLowerCase("en-US"))) return false;
  return fallback;
}

function summarizeBody(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .replace(/^#+\s*/u, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((paragraph) => paragraph && !paragraph.startsWith("<!--"));
  return paragraphs[0]?.slice(0, 500) ?? "Locally discovered capability";
}

function boundedDescription(value: string): string {
  return value.slice(0, MAX_DESCRIPTION_CHARACTERS);
}

function isValidCapabilityId(id: string): boolean {
  return CAPABILITY_ID_PATTERN.test(id);
}

function hasToken(tokens: readonly string[], expected: string): boolean {
  return tokens.includes(expected);
}

function inferTaskTypes(text: string, explicit: readonly string[]): TaskIntent[] {
  const declared = explicit.filter((value): value is TaskIntent =>
    TASK_TYPES.includes(value as TaskIntent),
  );
  if (declared.length > 0) return unique(declared) as TaskIntent[];
  const tokens = tokenizePrompt(text);
  const inferred = TASK_TYPES.filter((taskType) => {
    if (taskType === "security-audit")
      return (
        hasToken(tokens, "security") && (hasToken(tokens, "audit") || hasToken(tokens, "review"))
      );
    if (taskType === "implement")
      return ["implement", "build", "create", "code", "implementation"].some((token) =>
        hasToken(tokens, token),
      );
    if (taskType === "fix")
      return ["fix", "repair", "resolve", "correction"].some((token) => hasToken(tokens, token));
    if (taskType === "review")
      return ["review", "inspect", "critique"].some((token) => hasToken(tokens, token));
    if (taskType === "research")
      return ["research", "search", "explore", "investigate"].some((token) =>
        hasToken(tokens, token),
      );
    if (taskType === "design")
      return ["design", "architect", "architecture", "plan"].some((token) =>
        hasToken(tokens, token),
      );
    if (taskType === "refactor")
      return ["refactor", "restructure", "simplify"].some((token) => hasToken(tokens, token));
    if (taskType === "test")
      return ["test", "testing", "tests", "coverage"].some((token) => hasToken(tokens, token));
    if (taskType === "document")
      return ["document", "documentation", "docs", "readme"].some((token) =>
        hasToken(tokens, token),
      );
    if (taskType === "optimize")
      return ["optimize", "performance", "latency", "efficiency"].some((token) =>
        hasToken(tokens, token),
      );
    return ["debug", "diagnose", "trace", "root-cause"].some((token) => hasToken(tokens, token));
  });
  return inferred.length > 0 ? inferred : [...TASK_TYPES];
}

function inferDomains(text: string, explicit: readonly string[]): string[] {
  if (explicit.length > 0) return unique(explicit);
  const tokens = tokenizePrompt(text);
  const domains = Object.entries(DOMAIN_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => hasToken(tokens, keyword)))
    .map(([domain]) => domain);
  return domains.length > 0 ? domains : ["general"];
}

function parseRisk(value: string | undefined): RiskLevel {
  const normalized = value?.toLocaleLowerCase("en-US");
  return normalized && ["low", "medium", "high", "critical"].includes(normalized)
    ? (normalized as RiskLevel)
    : "medium";
}

function projectRiskCeiling(value: RiskLevel): RiskLevel {
  return value === "high" || value === "critical" ? "medium" : value;
}

async function walkMarkdownFiles(
  root: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
  budget: DiscoveryBudget,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth || budget.files <= 0 || budget.entries <= 0) return [];
  const entries: Dirent[] = [];
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (budget.entries <= 0) break;
      budget.entries -= 1;
      entries.push(entry);
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (budget.files <= 0) break;
    if (entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(path, predicate, maxDepth, budget, depth + 1)));
    } else if (entry.isFile() && predicate(entry.name)) {
      files.push(path);
      budget.files -= 1;
    }
  }
  return files;
}

async function readManifestFile(
  path: string,
  budget: DiscoveryBudget,
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW;
    file = await open(
      path,
      typeof noFollow === "number" ? fsConstants.O_RDONLY | noFollow : fsConstants.O_RDONLY,
    );
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES || metadata.size > budget.bytes) {
      return undefined;
    }
    const content = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalMetadata = await file.stat();
    // A manifest changed during discovery. Ignore the unstable snapshot rather
    // than parsing partial content or reading beyond the size that was checked.
    if (
      offset !== metadata.size ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs
    ) {
      return undefined;
    }
    budget.bytes -= metadata.size;
    return content.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function resolveRoots(options: CapabilityDiscoveryOptions): DiscoveryRoots {
  const cwd = resolve(options.cwd ?? process.cwd());
  const userHome = resolve(options.homeDir ?? homedir());
  const projectAgents: DiscoveryRoot[] = [
    {
      path: resolve(cwd, ".claude/agents"),
      origin: "project",
      providers: ["claude-code"],
      boundary: cwd,
    },
    {
      path: resolve(cwd, ".codex/agents"),
      origin: "project",
      providers: ["codex"],
      boundary: cwd,
    },
    { path: resolve(cwd, "agents"), origin: "project", boundary: cwd },
  ];
  const projectSkills: DiscoveryRoot[] = [
    {
      path: resolve(cwd, ".claude/skills"),
      origin: "project",
      providers: ["claude-code"],
      boundary: cwd,
    },
    {
      path: resolve(cwd, ".agents/skills"),
      origin: "project",
      providers: ["codex"],
      boundary: cwd,
    },
    {
      path: resolve(cwd, ".codex/skills"),
      origin: "project",
      providers: ["codex"],
      boundary: cwd,
    },
    { path: resolve(cwd, "skills"), origin: "project", boundary: cwd },
  ];
  const userAgents: DiscoveryRoot[] = [
    {
      path: resolve(userHome, ".claude/agents"),
      origin: "user",
      providers: ["claude-code"],
    },
    { path: resolve(userHome, ".codex/agents"), origin: "user", providers: ["codex"] },
  ];
  const userSkills: DiscoveryRoot[] = [
    {
      path: resolve(userHome, ".claude/skills"),
      origin: "user",
      providers: ["claude-code"],
    },
    { path: resolve(userHome, ".agents/skills"), origin: "user", providers: ["codex"] },
    { path: resolve(userHome, ".codex/skills"), origin: "user", providers: ["codex"] },
  ];
  return {
    agentRoots: uniqueDiscoveryRoots([
      ...(options.agentRoots ?? []).map((path) => ({ path, origin: "explicit" as const })),
      ...(options.includeProjectRoots === false ? [] : projectAgents),
      ...(options.includeUserRoots === false ? [] : userAgents),
    ]),
    skillRoots: uniqueDiscoveryRoots([
      ...(options.skillRoots ?? []).map((path) => ({ path, origin: "explicit" as const })),
      ...(options.includeProjectRoots === false ? [] : projectSkills),
      ...(options.includeUserRoots === false ? [] : userSkills),
    ]),
  };
}

function uniqueDiscoveryRoots(roots: readonly DiscoveryRoot[]): DiscoveryRoot[] {
  const seen = new Set<string>();
  return roots.flatMap((root) => {
    const path = resolve(root.path);
    if (seen.has(path)) return [];
    seen.add(path);
    return [
      {
        path,
        origin: root.origin,
        ...(root.providers === undefined ? {} : { providers: [...root.providers] }),
        ...(root.boundary === undefined ? {} : { boundary: resolve(root.boundary) }),
      },
    ];
  });
}

async function discoveryRootIsContained(root: DiscoveryRoot): Promise<boolean> {
  if (!root.boundary) return true;
  try {
    const [canonicalRoot, canonicalBoundary] = await Promise.all([
      realpath(root.path),
      realpath(root.boundary),
    ]);
    const fromBoundary = relative(canonicalBoundary, canonicalRoot);
    return (
      fromBoundary === "" ||
      (!isAbsolute(fromBoundary) &&
        fromBoundary !== ".." &&
        !fromBoundary.startsWith(`..${pathSeparator}`))
    );
  } catch {
    return false;
  }
}

function discoveryIdentity(root: DiscoveryRoot, id: string): string {
  return `${root.origin}\0${root.providers?.join(",") ?? "*"}\0${id}`;
}

function capabilityId(
  path: string,
  root: string,
  manifest: ParsedManifest,
  isSkill: boolean,
): string {
  const declared = attribute(manifest, "name", "id");
  if (declared) return declared;
  const pathName = isSkill ? basename(dirname(path)) : basename(path).replace(/\.md$/iu, "");
  const relativeName = relative(root, isSkill ? dirname(path) : path)
    .replace(/\.md$/iu, "")
    .replaceAll("\\", "/");
  return pathName === "agents" || !pathName ? relativeName : pathName;
}

function diagnosticAlias(
  origin: CapabilityOrigin,
  scope: string | undefined,
  id: string,
  suffix?: number,
): string {
  const candidate = [
    origin,
    ...(scope === undefined ? [] : [scope]),
    ...(suffix === undefined ? [] : [String(suffix)]),
    id,
  ].join(":");
  if (candidate.length <= 128) return candidate;
  const digest = stableHash(candidate).slice(0, 12);
  return `${candidate.slice(0, 115)}-${digest}`;
}

function providerScopesOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  const rightProviders = new Set(right);
  return left.some((provider) => rightProviders.has(provider));
}

async function discoverAgents(
  roots: readonly DiscoveryRoot[],
  maxDepth: number,
  budget: DiscoveryBudget,
): Promise<DiscoveredCapability<AgentCapability>[]> {
  const discovered: DiscoveredCapability<AgentCapability>[] = [];
  const ids = new Set<string>();
  for (const root of roots) {
    if (!(await discoveryRootIsContained(root))) continue;
    const files = await walkMarkdownFiles(
      root.path,
      (name) => name.endsWith(".md") && !/^readme\.md$/iu.test(name),
      maxDepth,
      budget,
    );
    for (const path of files) {
      const content = await readManifestFile(path, budget);
      if (content === undefined) continue;
      const manifest = parseManifest(content);
      const id = capabilityId(path, root.path, manifest, false);
      const originId = discoveryIdentity(root, id);
      if (!isValidCapabilityId(id) || ids.has(originId)) continue;
      ids.add(originId);
      const description = boundedDescription(
        attribute(manifest, "description") ?? summarizeBody(manifest.body),
      );
      const instructions = manifest.bodyComplete ? manifest.body.trim() : "";
      const declaredRisk = parseRisk(attribute(manifest, "risk-ceiling", "riskceiling"));
      discovered.push({
        origin: root.origin,
        ...(instructions ? { instructions } : {}),
        capability: {
          id,
          description,
          ...(instructions ? { instructionCharacters: instructions.length } : {}),
          ...(root.providers === undefined ? {} : { providers: [...root.providers] }),
          taskTypes: inferTaskTypes(
            `${id} ${description}`,
            attributeList(manifest, "task-types", "tasktypes", "intents"),
          ),
          domains: inferDomains(`${id} ${description}`, attributeList(manifest, "domains")),
          tools: attributeList(manifest, "tools", "allowed-tools", "allowedtools"),
          skills: attributeList(manifest, "skills").filter(isValidCapabilityId),
          riskCeiling: root.origin === "project" ? projectRiskCeiling(declaredRisk) : declaredRisk,
          contextOverheadTokens: instructions
            ? estimateTokens(JSON.stringify({ kind: "agent", id, instructions })) + 64
            : 0,
          enabled: attributeBoolean(manifest, "enabled", true),
        },
      });
    }
  }
  return discovered;
}

async function discoverSkills(
  roots: readonly DiscoveryRoot[],
  maxDepth: number,
  budget: DiscoveryBudget,
): Promise<DiscoveredCapability<SkillCapability>[]> {
  const discovered: DiscoveredCapability<SkillCapability>[] = [];
  const ids = new Set<string>();
  for (const root of roots) {
    if (!(await discoveryRootIsContained(root))) continue;
    const files = await walkMarkdownFiles(
      root.path,
      (name) => /^skill\.md$/iu.test(name),
      maxDepth,
      budget,
    );
    for (const path of files) {
      const content = await readManifestFile(path, budget);
      if (content === undefined) continue;
      const manifest = parseManifest(content);
      const id = capabilityId(path, root.path, manifest, true);
      const originId = discoveryIdentity(root, id);
      if (!isValidCapabilityId(id) || ids.has(originId)) continue;
      ids.add(originId);
      const description = boundedDescription(
        attribute(manifest, "description") ?? summarizeBody(manifest.body),
      );
      const instructions = manifest.bodyComplete ? manifest.body.trim() : "";
      discovered.push({
        origin: root.origin,
        ...(instructions ? { instructions } : {}),
        capability: {
          id,
          description,
          ...(instructions ? { instructionCharacters: instructions.length } : {}),
          ...(root.providers === undefined ? {} : { providers: [...root.providers] }),
          taskTypes: inferTaskTypes(
            `${id} ${description}`,
            attributeList(manifest, "task-types", "tasktypes", "intents"),
          ),
          domains: inferDomains(`${id} ${description}`, attributeList(manifest, "domains")),
          requiredTools: attributeList(manifest, "required-tools", "requiredtools", "tools"),
          contextOverheadTokens: instructions
            ? estimateTokens(JSON.stringify({ kind: "skill", id, instructions })) + 64
            : 0,
          // Trust is installation provenance, never a self-asserted manifest field.
          // Explicit roots are useful for discovery/tests but are not implicitly trusted.
          trusted: root.origin === "user",
          enabled: attributeBoolean(manifest, "enabled", true),
        },
      });
    }
  }
  return discovered;
}

const ORIGIN_PRIORITY: Readonly<Record<CapabilityOrigin, number>> = {
  explicit: 2,
  user: 1,
  project: 0,
};

/**
 * A user or explicitly selected capability keeps the real runtime id. Aliases
 * used to expose collision losers are diagnostic-only: runtimes cannot resolve
 * the synthetic id, so losers are disabled fail-closed.
 */
function resolveCapabilityIds<T extends { id: string; enabled: boolean; providers?: string[] }>(
  discovered: readonly DiscoveredCapability<T>[],
): DiscoveredCapability<T>[] {
  const groups = new Map<string, DiscoveredCapability<T>[]>();
  for (const item of discovered) {
    groups.set(item.capability.id, [...(groups.get(item.capability.id) ?? []), item]);
  }

  const losers = new Set<DiscoveredCapability<T>>();
  for (const group of groups.values()) {
    const accepted: DiscoveredCapability<T>[] = [];
    const ranked = [...group].sort(
      (left, right) => ORIGIN_PRIORITY[right.origin] - ORIGIN_PRIORITY[left.origin],
    );
    for (const candidate of ranked) {
      if (
        accepted.some((winner) =>
          providerScopesOverlap(winner.capability.providers, candidate.capability.providers),
        )
      ) {
        losers.add(candidate);
      } else {
        accepted.push(candidate);
      }
    }
  }

  const claimed = new Set(groups.keys());
  const resolved = discovered.map((item) => {
    if (!losers.has(item)) {
      return {
        ...item,
        capability: structuredClone(item.capability),
      };
    }

    const scope = item.capability.providers?.join("+") || "neutral";
    let id = diagnosticAlias(item.origin, undefined, item.capability.id);
    let suffix = 2;
    if (claimed.has(id)) id = diagnosticAlias(item.origin, scope, item.capability.id);
    while (claimed.has(id)) {
      id = diagnosticAlias(item.origin, scope, item.capability.id, suffix);
      suffix += 1;
    }
    claimed.add(id);
    return {
      ...item,
      capability: { ...structuredClone(item.capability), id, enabled: false },
    };
  });

  return resolved;
}

/** Returns enabled models exactly from enabled provider configuration. */
export function modelsFromConfig(config: RouterConfig): ModelCapability[] {
  return config.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          ...structuredClone(model),
          provider: provider.id,
          // Subscription runtimes still report token usage, but their marginal
          // per-run monetary cost is zero for routing and budget selection.
          ...(provider.billingMode === "subscription"
            ? { inputCostPerMillion: 0, outputCostPerMillion: 0, cachedInputCostPerMillion: 0 }
            : {}),
        })),
    );
}

async function discoverCapabilityCatalog(
  config: RouterConfig,
  options: CapabilityDiscoveryOptions = {},
): Promise<DiscoveredCapabilityCatalog> {
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? MAX_DISCOVERY_FILES;
  const maxEntries = options.maxEntries ?? MAX_DISCOVERY_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_DISCOVERY_BYTES;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32)
    throw new Error("maxDepth must be an integer between 0 and 32");
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_DISCOVERY_FILES) {
    throw new Error(`maxFiles must be a positive integer no greater than ${MAX_DISCOVERY_FILES}`);
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_DISCOVERY_ENTRIES) {
    throw new Error(`maxEntries must be an integer between 1 and ${MAX_DISCOVERY_ENTRIES}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DISCOVERY_BYTES) {
    throw new Error(`maxBytes must be an integer between 1 and ${MAX_DISCOVERY_BYTES}`);
  }
  if ((options.agentRoots?.length ?? 0) + (options.skillRoots?.length ?? 0) > MAX_DISCOVERY_ROOTS) {
    throw new Error(`Explicit capability roots cannot exceed ${MAX_DISCOVERY_ROOTS}`);
  }
  const roots = resolveRoots(options);
  const budget: DiscoveryBudget = { files: maxFiles, entries: maxEntries, bytes: maxBytes };
  // A fixed category order makes shared-budget exhaustion reproducible.
  const agents = resolveCapabilityIds(await discoverAgents(roots.agentRoots, maxDepth, budget));
  const skills = resolveCapabilityIds(await discoverSkills(roots.skillRoots, maxDepth, budget));
  return {
    snapshot: {
      models: modelsFromConfig(config),
      agents: agents.map(({ capability }) => capability),
      skills: skills.map(({ capability }) => capability),
      discoveredAt: new Date().toISOString(),
    },
    instructions: {
      agents: instructionSources(agents),
      skills: instructionSources(skills),
    },
  };
}

export async function discoverCapabilities(
  config: RouterConfig,
  options: CapabilityDiscoveryOptions = {},
): Promise<CapabilitySnapshot> {
  return structuredClone((await discoverCapabilityCatalog(config, options)).snapshot);
}

function instructionSources<T extends { id: string; enabled: boolean; providers?: string[] }>(
  capabilities: readonly DiscoveredCapability<T>[],
): CapabilityInstructionCatalog["agents"] {
  return capabilities.flatMap(({ capability, instructions }) =>
    capability.enabled && instructions
      ? [
          {
            id: capability.id,
            ...(capability.providers === undefined ? {} : { providers: [...capability.providers] }),
            instructions,
          },
        ]
      : [],
  );
}

export class CapabilityRegistry {
  readonly #config: RouterConfig;
  readonly #options: CapabilityDiscoveryOptions;
  #snapshot: CapabilitySnapshot;

  constructor(config: RouterConfig, options: CapabilityDiscoveryOptions = {}) {
    this.#config = config;
    this.#options = { ...options };
    this.#snapshot = {
      models: modelsFromConfig(config),
      agents: [],
      skills: [],
      discoveredAt: new Date(0).toISOString(),
    };
  }

  async refresh(): Promise<CapabilitySnapshot> {
    await this.#refreshCatalog();
    return this.snapshot();
  }

  /** Atomically binds route metadata validation and private prompt payloads to one generation. */
  async refreshRoute(route: RouteDecision): Promise<RouteCapabilityGeneration> {
    const catalog = await this.#refreshCatalog();
    if (!route.agent && route.skills.length === 0) {
      return { snapshot: structuredClone(catalog.snapshot) };
    }
    try {
      return {
        snapshot: structuredClone(catalog.snapshot),
        materialized: materializeRouteCapabilities(catalog.instructions, route),
      };
    } catch (error) {
      return {
        snapshot: structuredClone(catalog.snapshot),
        materializationError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  snapshot(): CapabilitySnapshot {
    return structuredClone(this.#snapshot);
  }

  findModel(provider: string, model: string): ModelCapability | undefined {
    const capability = this.#snapshot.models.find(
      (candidate) => candidate.provider === provider && candidate.model === model,
    );
    return capability ? structuredClone(capability) : undefined;
  }

  findAgent(id: string, provider?: string): AgentCapability | undefined {
    const capability = this.#snapshot.agents.find(
      (candidate) =>
        candidate.id === id &&
        (provider === undefined || capabilitySupportsProvider(candidate, provider)),
    );
    return capability ? structuredClone(capability) : undefined;
  }

  findSkill(id: string, provider?: string): SkillCapability | undefined {
    const capability = this.#snapshot.skills.find(
      (candidate) =>
        candidate.id === id &&
        (provider === undefined || capabilitySupportsProvider(candidate, provider)),
    );
    return capability ? structuredClone(capability) : undefined;
  }

  async #refreshCatalog(): Promise<DiscoveredCapabilityCatalog> {
    const catalog = await discoverCapabilityCatalog(this.#config, this.#options);
    this.#snapshot = catalog.snapshot;
    return catalog;
  }
}
