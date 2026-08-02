import type {
  AgentCapability,
  CapabilitySnapshot,
  EffortLevel,
  ModelCapability,
  PlanNode,
  RiskLevel,
  RouteDecision,
  SkillCapability,
} from "../contracts.ts";
import {
  capabilitySetFitsMaterialization,
  hasMaterializableInstructions,
  MAX_MATERIALIZED_SKILLS,
} from "./capability-materialization.ts";
import { capabilitySupportsProvider } from "./provider-scope.ts";

export interface RouteCapabilityValidationResult {
  valid: boolean;
  errors: string[];
}

const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const EFFORT_OUTPUT_MULTIPLIER: Readonly<Record<EffortLevel, number>> = {
  economy: 0.72,
  balanced: 1,
  deep: 1.28,
  max: 1.65,
};

/**
 * Revalidates a previously planned route against a fresh capability snapshot.
 * This is intentionally independent of providers and the runtime scheduler.
 */
export function validateRouteCapabilities(
  snapshot: CapabilitySnapshot,
  node: PlanNode,
  route: RouteDecision,
): RouteCapabilityValidationResult {
  const errors: string[] = [];
  const providerModels = snapshot.models.filter((model) => model.provider === route.provider);
  if (providerModels.length === 0) {
    errors.push(`Provider ${route.provider} is not enabled or registered`);
  }
  const model = providerModels.find((candidate) => candidate.model === route.model);
  if (!model) {
    errors.push(`Model ${route.provider}/${route.model} is not enabled or registered`);
  } else {
    validateModel(model, node, route, errors);
  }

  const riskLevel = effectiveRisk(node);
  const agent = validateAgent(snapshot, node, route, riskLevel, errors);
  const skills = validateSkills(snapshot, node, route, riskLevel, errors);
  if (!capabilitySetFitsMaterialization(agent, skills)) {
    errors.push("Selected capability instructions cannot be materialized within bounds");
  }
  if (model) validateContextCapacity(model, node, route, agent, skills, errors);

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertRouteCapabilities(
  snapshot: CapabilitySnapshot,
  node: PlanNode,
  route: RouteDecision,
): void {
  const validation = validateRouteCapabilities(snapshot, node, route);
  if (!validation.valid) {
    throw new Error(`Route capability validation failed: ${validation.errors.join("; ")}`);
  }
}

export function routeCapabilityValidationMessage(
  snapshot: CapabilitySnapshot,
  node: PlanNode,
  route: RouteDecision,
): true | string {
  const validation = validateRouteCapabilities(snapshot, node, route);
  return validation.valid
    ? true
    : `Route capability validation failed: ${validation.errors.join("; ")}`;
}

function validateModel(
  model: ModelCapability,
  node: PlanNode,
  route: RouteDecision,
  errors: string[],
): void {
  if (!model.enabled) errors.push(`Model ${route.provider}/${route.model} is disabled`);
  if (!model.supportedEfforts.includes(route.effort)) {
    errors.push(`Model ${route.provider}/${route.model} does not support ${route.effort} effort`);
  }
  if (!model.taskTypes.includes(node.routeRequest.taskIntent)) {
    errors.push(
      `Model ${route.provider}/${route.model} does not support ${node.routeRequest.taskIntent}`,
    );
  }
  if (!domainsOverlap(model.domains, node.routeRequest.domains)) {
    errors.push(`Model ${route.provider}/${route.model} is incompatible with the step domains`);
  }
  const missingRequiredTool = firstMissing(node.routeRequest.requiredTools, route.tools);
  if (missingRequiredTool) {
    errors.push(`Route is missing required step tool ${missingRequiredTool}`);
  }
  const unauthorizedRouteTool = firstMissing(route.tools, node.routeRequest.requiredTools);
  if (unauthorizedRouteTool) {
    errors.push(`Route contains unauthorized tool ${unauthorizedRouteTool}`);
  }
  const unsupportedRouteTool = firstMissing(route.tools, model.tools);
  if (unsupportedRouteTool) {
    errors.push(
      `Model ${route.provider}/${route.model} does not support route tool ${unsupportedRouteTool}`,
    );
  }
  if (new Set(normalize(route.tools)).size !== route.tools.length) {
    errors.push("Route contains duplicate tools");
  }
  if (has(route.tools, "Agent")) errors.push("Native Agent tool is disabled for prompt delivery");
  if (has(route.tools, "Skill")) errors.push("Native Skill tool is disabled for prompt delivery");
}

function validateAgent(
  snapshot: CapabilitySnapshot,
  node: PlanNode,
  route: RouteDecision,
  riskLevel: RiskLevel,
  errors: string[],
): AgentCapability | undefined {
  if (!route.agent) return undefined;

  const installedAgents = snapshot.agents.filter((candidate) => candidate.id === route.agent);
  if (installedAgents.length === 0) {
    errors.push(`Agent ${route.agent} is not enabled or registered`);
    return undefined;
  }
  const agent =
    installedAgents.find(
      (candidate) => candidate.enabled && capabilitySupportsProvider(candidate, route.provider),
    ) ??
    installedAgents.find((candidate) => capabilitySupportsProvider(candidate, route.provider)) ??
    installedAgents[0];
  if (!agent) return undefined;
  if (!agent.enabled) errors.push(`Agent ${route.agent} is disabled`);
  if (!hasMaterializableInstructions(agent)) {
    errors.push(`Agent ${route.agent} has no complete bounded runtime instructions`);
  }
  if (!capabilitySupportsProvider(agent, route.provider)) {
    errors.push(`Agent ${route.agent} is not available for provider ${route.provider}`);
  }
  if (!agent.taskTypes.includes(node.routeRequest.taskIntent)) {
    errors.push(`Agent ${route.agent} does not support ${node.routeRequest.taskIntent}`);
  }
  if (!domainsOverlap(agent.domains, node.routeRequest.domains)) {
    errors.push(`Agent ${route.agent} is incompatible with the step domains`);
  }
  if (RISK_RANK[agent.riskCeiling] < RISK_RANK[riskLevel]) {
    errors.push(`Agent ${route.agent} risk ceiling is below ${riskLevel}`);
  }
  const missingAgentTool = firstMissing(agent.tools, route.tools);
  if (missingAgentTool) {
    errors.push(`Route for agent ${route.agent} is missing agent tool ${missingAgentTool}`);
  }
  return agent;
}

function validateSkills(
  snapshot: CapabilitySnapshot,
  node: PlanNode,
  route: RouteDecision,
  riskLevel: RiskLevel,
  errors: string[],
): SkillCapability[] {
  if (new Set(route.skills).size !== route.skills.length)
    errors.push("Route contains duplicate skills");
  if (route.skills.length > MAX_MATERIALIZED_SKILLS) {
    errors.push(`Route cannot materialize more than ${MAX_MATERIALIZED_SKILLS} skills`);
  }

  const selected: SkillCapability[] = [];
  for (const id of route.skills) {
    const installedSkills = snapshot.skills.filter((candidate) => candidate.id === id);
    if (installedSkills.length === 0) {
      errors.push(`Skill ${id} is not enabled or registered`);
      continue;
    }
    const skill =
      installedSkills.find(
        (candidate) => candidate.enabled && capabilitySupportsProvider(candidate, route.provider),
      ) ??
      installedSkills.find((candidate) => capabilitySupportsProvider(candidate, route.provider)) ??
      installedSkills[0];
    if (!skill) continue;
    selected.push(skill);
    if (!skill.enabled) errors.push(`Skill ${id} is disabled`);
    if (!hasMaterializableInstructions(skill)) {
      errors.push(`Skill ${id} has no complete bounded runtime instructions`);
    }
    if (!capabilitySupportsProvider(skill, route.provider)) {
      errors.push(`Skill ${id} is not available for provider ${route.provider}`);
    }
    if (!skill.taskTypes.includes(node.routeRequest.taskIntent)) {
      errors.push(`Skill ${id} does not support ${node.routeRequest.taskIntent}`);
    }
    if (!domainsOverlap(skill.domains, node.routeRequest.domains)) {
      errors.push(`Skill ${id} is incompatible with the step domains`);
    }
    if ((riskLevel === "high" || riskLevel === "critical") && !skill.trusted) {
      errors.push(`Skill ${id} is not trusted for ${riskLevel} risk`);
    }
    const missingSkillTool = firstMissing(skill.requiredTools, route.tools);
    if (missingSkillTool)
      errors.push(`Route for skill ${id} is missing required tool ${missingSkillTool}`);
  }
  return selected;
}

function validateContextCapacity(
  model: ModelCapability,
  node: PlanNode,
  route: RouteDecision,
  agent: AgentCapability | undefined,
  skills: readonly SkillCapability[],
  errors: string[],
): void {
  const inputTokens =
    node.routeRequest.expectedInputTokens +
    (agent?.contextOverheadTokens ?? 0) +
    skills.reduce((total, skill) => total + skill.contextOverheadTokens, 0);
  const outputTokens = Math.ceil(
    node.routeRequest.expectedOutputTokens * EFFORT_OUTPUT_MULTIPLIER[route.effort],
  );
  const hardInputBudget = Math.min(
    node.contextBudget,
    node.routeRequest.maxInputTokens ?? Number.POSITIVE_INFINITY,
  );
  if (inputTokens > hardInputBudget) {
    errors.push("Selected capability context exceeds the step input budget");
  }
  if (outputTokens > model.maxOutputTokens) {
    errors.push(`Model ${model.provider}/${model.model} output limit is below the planned output`);
  }
  if (inputTokens + outputTokens > model.contextWindow) {
    errors.push(
      `Model ${model.provider}/${model.model} context window is below the planned context`,
    );
  }
}

function effectiveRisk(node: PlanNode): RiskLevel {
  return RISK_RANK[node.routeRequest.riskLevel] > RISK_RANK[node.riskLevel]
    ? node.routeRequest.riskLevel
    : node.riskLevel;
}

function domainsOverlap(
  capabilityDomains: readonly string[],
  requestedDomains: readonly string[],
): boolean {
  const capability = new Set(normalize(capabilityDomains));
  const requested = new Set(normalize(requestedDomains));
  if (capability.has("general") || requested.has("general")) return true;
  return [...capability].some((domain) => requested.has(domain));
}

function firstMissing(
  required: readonly string[],
  available: readonly string[],
): string | undefined {
  const normalizedAvailable = new Set(normalize(available));
  return required.find((item) => !normalizedAvailable.has(item.toLocaleLowerCase("en-US")));
}

function has(values: readonly string[], expected: string): boolean {
  return normalize(values).includes(expected.toLocaleLowerCase("en-US"));
}

function normalize(values: readonly string[]): string[] {
  return values.map((value) => value.toLocaleLowerCase("en-US"));
}
