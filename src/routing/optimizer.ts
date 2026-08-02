import type {
  AgentCapability,
  CapabilitySnapshot,
  EffortLevel,
  ExecutionPlan,
  ModelCapability,
  RiskLevel,
  RouteDecision,
  RouteRequest,
  RouterConfig,
  SkillCapability,
} from "../contracts.ts";
import {
  capabilitySetFitsMaterialization,
  hasMaterializableInstructions,
  MAX_MATERIALIZED_SKILLS,
} from "./capability-materialization.ts";
import { capabilitySupportsProvider } from "./provider-scope.ts";

export interface RouteOptimizationOptions {
  maxCostUsd?: number;
  maxFallbacks?: number;
  requiredProvider?: string;
  requiredModel?: string;
  requiredEffort?: EffortLevel;
  requiredAgent?: string;
  requiredSkills?: string[];
  disableAgents?: boolean;
  disableSkills?: boolean;
}

export interface EvaluatedRoute {
  decision: RouteDecision;
  qualifies: boolean;
  rejectionReasons: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface OptimizedRoute {
  primary: RouteDecision;
  fallbacks: RouteDecision[];
  effectiveQualityFloor: number;
  considered: EvaluatedRoute[];
}

export interface RoutedExecutionPlan {
  plan: ExecutionPlan;
  fallbacks: Record<string, RouteDecision[]>;
  predictedPrimaryCallCostUsd: number;
}

/**
 * Automatic capability search is deliberately finite. Every subset of the
 * admitted skill pool is evaluated, so the selected route is least-cost within
 * this documented space instead of depending on prefix-only combinations.
 */
export const MAX_AUTOMATIC_AGENT_CANDIDATES = 4;
export const MAX_AUTOMATIC_SKILL_CANDIDATES = 8;
export const MAX_AUTOMATIC_SKILL_COMBINATIONS = 2 ** MAX_AUTOMATIC_SKILL_CANDIDATES;

const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const RISK_QUALITY_FLOOR: Readonly<Record<RiskLevel, number>> = {
  low: 0.76,
  medium: 0.83,
  high: 0.9,
  critical: 0.95,
};

const EFFORT_POLICY: Readonly<
  Record<
    EffortLevel,
    {
      qualityAdjustment: number;
      outputMultiplier: number;
      latencyMultiplier: number;
    }
  >
> = {
  economy: { qualityAdjustment: -0.04, outputMultiplier: 0.72, latencyMultiplier: 0.72 },
  balanced: { qualityAdjustment: 0, outputMultiplier: 1, latencyMultiplier: 1 },
  deep: { qualityAdjustment: 0.035, outputMultiplier: 1.28, latencyMultiplier: 1.35 },
  max: { qualityAdjustment: 0.06, outputMultiplier: 1.65, latencyMultiplier: 1.8 },
};

const PROFILE_QUALITY_ADJUSTMENT: Readonly<Record<RouterConfig["profile"], number>> = {
  economy: 0,
  balanced: 0,
  quality: 0.03,
  compliance: 0.04,
};

function clamp(value: number): number {
  return Math.min(0.999, Math.max(0, value));
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLocaleLowerCase("en-US")));
}

function includesAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const available = normalizedSet(haystack);
  return needles.every((needle) => available.has(needle.toLocaleLowerCase("en-US")));
}

function domainMatch(
  capabilityDomains: readonly string[],
  requestedDomains: readonly string[],
): boolean {
  if (capabilityDomains.includes("general") || requestedDomains.includes("general")) return true;
  const requested = normalizedSet(requestedDomains);
  return capabilityDomains.some((domain) => requested.has(domain.toLocaleLowerCase("en-US")));
}

function domainOverlap(
  capabilityDomains: readonly string[],
  requestedDomains: readonly string[],
): number {
  if (capabilityDomains.includes("general")) return 0;
  const requested = normalizedSet(requestedDomains);
  return capabilityDomains.reduce(
    (count, domain) => count + (requested.has(domain.toLocaleLowerCase("en-US")) ? 1 : 0),
    0,
  );
}

function agentCompatible(agent: AgentCapability, request: RouteRequest): boolean {
  return (
    agent.enabled &&
    hasMaterializableInstructions(agent) &&
    includesAll(request.requiredTools, agent.tools) &&
    agent.taskTypes.includes(request.taskIntent) &&
    domainMatch(agent.domains, request.domains) &&
    RISK_RANK[agent.riskCeiling] >= RISK_RANK[request.riskLevel]
  );
}

function skillCompatible(
  skill: SkillCapability,
  request: RouteRequest,
  config: RouterConfig,
): boolean {
  const requiresTrust =
    request.riskLevel === "high" ||
    request.riskLevel === "critical" ||
    config.profile === "compliance";
  return (
    skill.enabled &&
    hasMaterializableInstructions(skill) &&
    includesAll(request.requiredTools, skill.requiredTools) &&
    skill.taskTypes.includes(request.taskIntent) &&
    domainMatch(skill.domains, request.domains) &&
    (!requiresTrust || skill.trusted)
  );
}

function rankAgents(agents: readonly AgentCapability[], request: RouteRequest): AgentCapability[] {
  return agents
    .filter((agent) => agentCompatible(agent, request))
    .sort((left, right) => {
      const domainDifference =
        domainOverlap(right.domains, request.domains) -
        domainOverlap(left.domains, request.domains);
      return (
        domainDifference ||
        left.contextOverheadTokens - right.contextOverheadTokens ||
        left.id.localeCompare(right.id)
      );
    });
}

function rankSkills(
  skills: readonly SkillCapability[],
  request: RouteRequest,
  config: RouterConfig,
  provider: string,
  agent?: AgentCapability,
): SkillCapability[] {
  const agentSkills = new Set(agent?.skills ?? []);
  return skills
    .filter(
      (skill) =>
        skillCompatible(skill, request, config) && capabilitySupportsProvider(skill, provider),
    )
    .sort((left, right) => {
      const preferredDifference =
        Number(agentSkills.has(right.id)) - Number(agentSkills.has(left.id));
      const domainDifference =
        domainOverlap(right.domains, request.domains) -
        domainOverlap(left.domains, request.domains);
      return (
        preferredDifference ||
        domainDifference ||
        left.contextOverheadTokens - right.contextOverheadTokens ||
        left.id.localeCompare(right.id)
      );
    });
}

function skillSets(
  skills: readonly SkillCapability[],
  requiredIds: readonly string[],
  disabled: boolean,
): SkillCapability[][] {
  if (disabled) return [[]];
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const required = requiredIds.flatMap((id) => {
    const skill = byId.get(id);
    return skill ? [skill] : [];
  });
  if (required.length !== requiredIds.length) return [];
  const optional = skills
    .filter((skill) => !requiredIds.includes(skill.id))
    .slice(0, MAX_AUTOMATIC_SKILL_CANDIDATES);
  const remainingSlots = MAX_MATERIALIZED_SKILLS - required.length;
  if (remainingSlots < 0) return [];

  const sets: SkillCapability[][] = [];
  const combinationCount = 2 ** optional.length;
  for (let mask = 0; mask < combinationCount; mask += 1) {
    const selected: SkillCapability[] = [];
    for (let index = 0; index < optional.length; index += 1) {
      if ((mask & (1 << index)) !== 0) selected.push(optional[index] as SkillCapability);
    }
    if (selected.length <= remainingSlots) sets.push([...required, ...selected]);
  }
  return sets;
}

function effectiveQualityFloor(request: RouteRequest, config: RouterConfig): number {
  return Math.min(
    1,
    Math.max(
      0,
      Math.max(request.qualityFloor, RISK_QUALITY_FLOOR[request.riskLevel]) +
        PROFILE_QUALITY_ADJUSTMENT[config.profile],
    ),
  );
}

function qualityEstimate(
  model: ModelCapability,
  effort: EffortLevel,
  request: RouteRequest,
  agent: AgentCapability | undefined,
  skills: readonly SkillCapability[],
): number {
  const specializedModel = domainOverlap(model.domains, request.domains) > 0 ? 0.018 : 0;
  const agentBoost = agent
    ? 0.018 + Math.min(0.012, domainOverlap(agent.domains, request.domains) * 0.006)
    : 0;
  const skillBoost = skills.reduce(
    (total, skill) =>
      total + 0.008 + Math.min(0.004, domainOverlap(skill.domains, request.domains) * 0.002),
    0,
  );
  return clamp(
    model.qualityPrior +
      EFFORT_POLICY[effort].qualityAdjustment +
      specializedModel +
      agentBoost +
      Math.min(0.032, skillBoost),
  );
}

function estimateCost(
  model: ModelCapability,
  effort: EffortLevel,
  request: RouteRequest,
  agent: AgentCapability | undefined,
  skills: readonly SkillCapability[],
): { cost: number; inputTokens: number; outputTokens: number; latencyMs: number } {
  const inputTokens =
    request.expectedInputTokens +
    (agent?.contextOverheadTokens ?? 0) +
    skills.reduce((sum, skill) => sum + skill.contextOverheadTokens, 0);
  const outputTokens = Math.ceil(
    request.expectedOutputTokens * EFFORT_POLICY[effort].outputMultiplier,
  );
  const cost =
    (inputTokens / 1_000_000) * model.inputCostPerMillion +
    (outputTokens / 1_000_000) * model.outputCostPerMillion;
  const latencyMs = Math.ceil(
    model.latencyPriorMs * EFFORT_POLICY[effort].latencyMultiplier +
      (agent ? 350 : 0) +
      skills.length * 100,
  );
  return { cost, inputTokens, outputTokens, latencyMs };
}

function routeSignature(route: RouteDecision): string {
  return [route.provider, route.model, route.effort, route.agent ?? "", ...route.skills].join("|");
}

function compareRoutes(
  left: EvaluatedRoute,
  right: EvaluatedRoute,
  preferredProvider: string | undefined,
): number {
  const costDifference = left.decision.expectedCostUsd - right.decision.expectedCostUsd;
  if (Math.abs(costDifference) > 0.000_000_1) return costDifference;
  const tokenDifference =
    left.estimatedInputTokens +
    left.estimatedOutputTokens -
    (right.estimatedInputTokens + right.estimatedOutputTokens);
  if (tokenDifference) return tokenDifference;
  const preferredDifference =
    Number(right.decision.provider === preferredProvider) -
    Number(left.decision.provider === preferredProvider);
  if (preferredDifference) return preferredDifference;
  const latencyDifference = left.decision.expectedLatencyMs - right.decision.expectedLatencyMs;
  if (latencyDifference) return latencyDifference;
  const qualityDifference = right.decision.expectedQuality - left.decision.expectedQuality;
  if (qualityDifference) return qualityDifference;
  return routeSignature(left.decision).localeCompare(routeSignature(right.decision));
}

function evaluateCombination(
  model: ModelCapability,
  effort: EffortLevel,
  request: RouteRequest,
  qualityFloor: number,
  maxCostUsd: number,
  agent: AgentCapability | undefined,
  skills: readonly SkillCapability[],
): EvaluatedRoute {
  const tools = [...new Set(request.requiredTools)];
  const estimate = estimateCost(model, effort, request, agent, skills);
  const quality = qualityEstimate(model, effort, request, agent, skills);
  const rejectionReasons: string[] = [];
  if (!model.enabled) rejectionReasons.push("model is disabled");
  if (!model.taskTypes.includes(request.taskIntent))
    rejectionReasons.push(`model does not support ${request.taskIntent}`);
  if (!domainMatch(model.domains, request.domains))
    rejectionReasons.push("model does not support a requested domain");
  if (!model.supportedEfforts.includes(effort))
    rejectionReasons.push(`model does not support ${effort} effort`);
  if (agent && !capabilitySupportsProvider(agent, model.provider))
    rejectionReasons.push(`agent is not available for provider ${model.provider}`);
  if (skills.some((skill) => !capabilitySupportsProvider(skill, model.provider)))
    rejectionReasons.push(`one or more skills are not available for provider ${model.provider}`);
  if (!capabilitySetFitsMaterialization(agent, skills))
    rejectionReasons.push("selected capability instructions cannot be materialized within bounds");
  if (includesAll(tools, ["Agent"]) || includesAll(tools, ["Skill"])) {
    rejectionReasons.push("native Agent and Skill tools are disabled for prompt-only delivery");
  }
  if (!includesAll(model.tools, tools))
    rejectionReasons.push("model lacks one or more required tools");
  if (request.maxInputTokens !== undefined && estimate.inputTokens > request.maxInputTokens) {
    rejectionReasons.push("input and capability context exceed the step input budget");
  }
  if (estimate.inputTokens + estimate.outputTokens > model.contextWindow)
    rejectionReasons.push("input, output, and capability context exceed the model context window");
  if (estimate.outputTokens > model.maxOutputTokens)
    rejectionReasons.push("estimated output exceeds the model output limit");
  if (quality < qualityFloor)
    rejectionReasons.push(
      `expected quality ${quality.toFixed(3)} is below ${qualityFloor.toFixed(3)}`,
    );
  if (estimate.cost > maxCostUsd)
    rejectionReasons.push(
      `expected cost $${estimate.cost.toFixed(6)} exceeds step budget $${maxCostUsd.toFixed(6)}`,
    );
  if (request.maxLatencyMs !== undefined && estimate.latencyMs > request.maxLatencyMs) {
    rejectionReasons.push(
      `expected latency ${estimate.latencyMs}ms exceeds run deadline ${request.maxLatencyMs}ms`,
    );
  }
  if (
    ![
      model.inputCostPerMillion,
      model.outputCostPerMillion,
      model.qualityPrior,
      model.latencyPriorMs,
    ].every((value) => Number.isFinite(value) && value >= 0)
  ) {
    rejectionReasons.push("model has invalid cost, quality, or latency metadata");
  }

  const reasonParts = [
    `${model.displayName} at ${effort} effort`,
    agent ? `specialist ${agent.id}` : "no subagent overhead",
    skills.length > 0 ? `skills ${skills.map(({ id }) => id).join(", ")}` : "no skill overhead",
    `quality ${quality.toFixed(3)}`,
    `predicted primary-call cost $${estimate.cost.toFixed(6)}`,
  ];
  const decision: RouteDecision = {
    provider: model.provider,
    model: model.model,
    effort,
    ...(agent ? { agent: agent.id } : {}),
    skills: skills.map(({ id }) => id),
    tools,
    expectedQuality: quality,
    expectedCostUsd: estimate.cost,
    expectedLatencyMs: estimate.latencyMs,
    reason: reasonParts.join("; "),
  };
  return {
    decision,
    qualifies: rejectionReasons.length === 0,
    rejectionReasons,
    estimatedInputTokens: estimate.inputTokens,
    estimatedOutputTokens: estimate.outputTokens,
  };
}

function assertRequiredCapabilities(
  snapshot: CapabilitySnapshot,
  request: RouteRequest,
  config: RouterConfig,
  options: RouteOptimizationOptions,
  models: readonly ModelCapability[],
): void {
  let eligibleProviders = new Set(models.map(({ provider }) => provider));
  if (options.requiredAgent) {
    if (options.disableAgents)
      throw new Error("requiredAgent cannot be combined with disableAgents");
    const installedAgents = snapshot.agents.filter(({ id }) => id === options.requiredAgent);
    if (installedAgents.length === 0)
      throw new Error(`Required agent is not installed: ${options.requiredAgent}`);
    const compatibleAgents = installedAgents.filter((agent) => agentCompatible(agent, request));
    if (compatibleAgents.length === 0)
      throw new Error(
        `Required agent is incompatible with step ${request.stepId}: ${options.requiredAgent}`,
      );
    eligibleProviders = new Set(
      [...eligibleProviders].filter((provider) =>
        compatibleAgents.some((agent) => capabilitySupportsProvider(agent, provider)),
      ),
    );
    if (eligibleProviders.size === 0) {
      throw new Error(
        `Required agent is not available for the selected provider/model set: ${options.requiredAgent}`,
      );
    }
  }
  if ((options.requiredSkills?.length ?? 0) > 0 && options.disableSkills) {
    throw new Error("requiredSkills cannot be combined with disableSkills");
  }
  for (const id of options.requiredSkills ?? []) {
    const installedSkills = snapshot.skills.filter((candidate) => candidate.id === id);
    if (installedSkills.length === 0) throw new Error(`Required skill is not installed: ${id}`);
    const compatibleSkills = installedSkills.filter((skill) =>
      skillCompatible(skill, request, config),
    );
    if (compatibleSkills.length === 0)
      throw new Error(
        `Required skill is incompatible or untrusted for step ${request.stepId}: ${id}`,
      );
    eligibleProviders = new Set(
      [...eligibleProviders].filter((provider) =>
        compatibleSkills.some((skill) => capabilitySupportsProvider(skill, provider)),
      ),
    );
    if (eligibleProviders.size === 0) {
      throw new Error(
        `Required skill does not share an eligible provider with the selected route capabilities: ${id}`,
      );
    }
  }
}

/**
 * Finds the lowest predicted primary-call-cost route inside the bounded
 * candidate space that clears every eligibility gate.
 * More expensive qualifying candidates become ordered escalation fallbacks.
 */
export function optimizeRoute(
  request: RouteRequest,
  snapshot: CapabilitySnapshot,
  config: RouterConfig,
  options: RouteOptimizationOptions = {},
): OptimizedRoute {
  if (request.expectedInputTokens < 0 || request.expectedOutputTokens < 0) {
    throw new Error("Expected token counts cannot be negative");
  }
  if (
    request.maxInputTokens !== undefined &&
    (!Number.isFinite(request.maxInputTokens) || request.maxInputTokens <= 0)
  ) {
    throw new Error("maxInputTokens must be greater than zero when provided");
  }
  if (
    request.maxLatencyMs !== undefined &&
    (!Number.isFinite(request.maxLatencyMs) || request.maxLatencyMs <= 0)
  ) {
    throw new Error("maxLatencyMs must be greater than zero when provided");
  }
  const maxCostUsd = options.maxCostUsd ?? config.budget.maxCostUsd;
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)
    throw new Error("maxCostUsd must be greater than zero");
  const selectedModels = snapshot.models.filter(
    (model) =>
      (!options.requiredProvider || model.provider === options.requiredProvider) &&
      (!options.requiredModel || model.model === options.requiredModel),
  );
  if (selectedModels.length === 0) {
    const requested = [options.requiredProvider, options.requiredModel].filter(Boolean).join("/");
    throw new Error(`Required provider/model is not available: ${requested || "<none>"}`);
  }
  if (
    options.requiredEffort &&
    !selectedModels.some((model) =>
      model.supportedEfforts.includes(options.requiredEffort as EffortLevel),
    )
  ) {
    throw new Error(
      `Required effort is not supported by the selected model set: ${options.requiredEffort}`,
    );
  }
  const models = options.requiredEffort
    ? selectedModels.filter((model) =>
        model.supportedEfforts.includes(options.requiredEffort as EffortLevel),
      )
    : selectedModels;
  const requiredSkills = [...new Set(options.requiredSkills ?? [])];
  if (requiredSkills.length > MAX_MATERIALIZED_SKILLS) {
    throw new Error(`Cannot require more than ${MAX_MATERIALIZED_SKILLS} skills per route`);
  }
  assertRequiredCapabilities(snapshot, request, config, options, models);

  const floor = effectiveQualityFloor(request, config);
  const rankedAgents = options.disableAgents
    ? []
    : rankAgents(snapshot.agents, request).filter(
        (agent) => !options.requiredAgent || agent.id === options.requiredAgent,
      );
  const considered: EvaluatedRoute[] = [];

  for (const model of models) {
    const agents = rankedAgents
      .filter((agent) => capabilitySupportsProvider(agent, model.provider))
      .slice(0, MAX_AUTOMATIC_AGENT_CANDIDATES);
    const agentOptions: Array<AgentCapability | undefined> = options.requiredAgent
      ? agents
      : [undefined, ...agents];
    for (const effort of model.supportedEfforts.filter(
      (candidate) => !options.requiredEffort || candidate === options.requiredEffort,
    )) {
      for (const agent of agentOptions) {
        const relevantSkills = rankSkills(snapshot.skills, request, config, model.provider, agent);
        const sets = skillSets(relevantSkills, requiredSkills, options.disableSkills ?? false);
        for (const skills of sets) {
          considered.push(
            evaluateCombination(model, effort, request, floor, maxCostUsd, agent, skills),
          );
        }
      }
    }
  }

  const preferredProvider = request.preferredProvider ?? config.preferredProvider;
  const qualifying = considered
    .filter(({ qualifies }) => qualifies)
    .sort((left, right) => compareRoutes(left, right, preferredProvider));
  const primary = qualifying[0];
  if (!primary) {
    const diagnostics = considered
      .slice(0, 12)
      .map(
        ({ decision, rejectionReasons }) =>
          `${decision.provider}/${decision.model}/${decision.effort}: ${rejectionReasons.join(", ")}`,
      )
      .join("\n");
    throw new Error(
      `No route satisfies step ${request.stepId} at quality floor ${floor.toFixed(3)} within $${maxCostUsd.toFixed(6)}.${diagnostics ? `\n${diagnostics}` : " No enabled models were discovered."}`,
    );
  }

  primary.decision.reason = `Lowest predicted primary-call cost in the bounded candidate space meeting the ${floor.toFixed(3)} quality floor: ${primary.decision.reason}`;
  const fallbackLimit = Math.max(0, options.maxFallbacks ?? config.budget.maxAttempts - 1);
  const seen = new Set([routeSignature(primary.decision)]);
  const orderedFallbacks = qualifying
    .slice(1)
    .filter(({ decision }) => {
      const signature = routeSignature(decision);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .sort((left, right) => {
      const leftBelowPrimary = left.decision.expectedQuality < primary.decision.expectedQuality;
      const rightBelowPrimary = right.decision.expectedQuality < primary.decision.expectedQuality;
      if (leftBelowPrimary !== rightBelowPrimary) {
        return Number(leftBelowPrimary) - Number(rightBelowPrimary);
      }
      const qualityDifference = leftBelowPrimary
        ? right.decision.expectedQuality - left.decision.expectedQuality
        : left.decision.expectedQuality - right.decision.expectedQuality;
      return qualityDifference || compareRoutes(left, right, preferredProvider);
    });
  const selectedFallbacks: EvaluatedRoute[] = [];
  // A single retry must escape a provider-wide outage. Prefer a qualified
  // provider-diverse route before same-provider model/effort variants.
  const firstFallback =
    orderedFallbacks.find(({ decision }) => decision.provider !== primary.decision.provider) ??
    orderedFallbacks[0];
  if (firstFallback && fallbackLimit > 0) selectedFallbacks.push(firstFallback);
  if (
    fallbackLimit > 1 &&
    !selectedFallbacks.some(({ decision }) => decision.provider !== primary.decision.provider)
  ) {
    const providerDiverse = orderedFallbacks.find(
      ({ decision }) =>
        decision.provider !== primary.decision.provider &&
        !selectedFallbacks.some(
          ({ decision: selected }) => routeSignature(selected) === routeSignature(decision),
        ),
    );
    if (providerDiverse) selectedFallbacks.push(providerDiverse);
  }
  for (const candidate of orderedFallbacks) {
    if (selectedFallbacks.length >= fallbackLimit) break;
    if (
      !selectedFallbacks.some(
        ({ decision }) => routeSignature(decision) === routeSignature(candidate.decision),
      )
    ) {
      selectedFallbacks.push(candidate);
    }
  }
  const fallbackCandidates = selectedFallbacks
    .slice(0, fallbackLimit)
    .map(({ decision }, index) => ({
      ...decision,
      reason: `Escalation fallback ${index + 1}: ${decision.reason}`,
    }));

  return {
    primary: structuredClone(primary.decision),
    fallbacks: structuredClone(fallbackCandidates),
    effectiveQualityFloor: floor,
    considered: structuredClone(considered),
  };
}

export function selectRoute(
  request: RouteRequest,
  snapshot: CapabilitySnapshot,
  config: RouterConfig,
  options: RouteOptimizationOptions = {},
): RouteDecision {
  return optimizeRoute(request, snapshot, config, options).primary;
}

/** Routes every plan node while preserving a separate escalation ladder. */
export function routeExecutionPlan(
  source: ExecutionPlan,
  snapshot: CapabilitySnapshot,
  config: RouterConfig,
  options: RouteOptimizationOptions = {},
): RoutedExecutionPlan {
  const plan = structuredClone(source);
  const fallbacks: Record<string, RouteDecision[]> = {};
  let predictedPrimaryCallCostUsd = 0;
  for (const node of plan.nodes) {
    const optimized = optimizeRoute(node.routeRequest, snapshot, config, {
      ...options,
      maxCostUsd: Math.min(node.maxCostUsd, options.maxCostUsd ?? Number.POSITIVE_INFINITY),
      maxFallbacks: options.maxFallbacks ?? Math.max(0, node.maxAttempts - 1),
    });
    node.route = optimized.primary;
    fallbacks[node.id] = optimized.fallbacks;
    predictedPrimaryCallCostUsd += optimized.primary.expectedCostUsd;
  }
  if (predictedPrimaryCallCostUsd > plan.task.budget.maxCostUsd) {
    throw new Error(
      `Predicted primary-call cost $${predictedPrimaryCallCostUsd.toFixed(6)} exceeds task budget $${plan.task.budget.maxCostUsd.toFixed(6)}`,
    );
  }
  plan.predictedPrimaryCallCostUsd = predictedPrimaryCallCostUsd;
  plan.explanation.push(
    `Selected the lowest predicted primary-call cost within the bounded candidate space for each stage; primary route total $${predictedPrimaryCallCostUsd.toFixed(6)}.`,
  );
  return { plan, fallbacks, predictedPrimaryCallCostUsd };
}

export const routePlan = routeExecutionPlan;
