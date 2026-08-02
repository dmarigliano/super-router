import type {
  AgentCapability,
  MaterializedCapabilityInstruction,
  MaterializedRouteCapabilities,
  RouteDecision,
  SkillCapability,
} from "../contracts.ts";
import { capabilitySupportsProvider } from "./provider-scope.ts";

export const MAX_CAPABILITY_INSTRUCTION_CHARACTERS = 4_096;
export const MAX_MATERIALIZED_CAPABILITY_CHARACTERS = 16_384;
export const MAX_MATERIALIZED_SKILLS = 8;

type PromptCapability = Pick<AgentCapability | SkillCapability, "id" | "instructionCharacters">;

export interface CapabilityInstructionSource {
  id: string;
  providers?: string[];
  instructions: string;
}

export interface CapabilityInstructionCatalog {
  agents: CapabilityInstructionSource[];
  skills: CapabilityInstructionSource[];
}

/** A capability is quality-bearing only when its complete prompt payload is bounded. */
export function hasMaterializableInstructions(capability: PromptCapability): boolean {
  return (
    Number.isInteger(capability.instructionCharacters) &&
    (capability.instructionCharacters ?? 0) > 0 &&
    (capability.instructionCharacters ?? 0) <= MAX_CAPABILITY_INSTRUCTION_CHARACTERS
  );
}

export function capabilitySetFitsMaterialization(
  agent: AgentCapability | undefined,
  skills: readonly SkillCapability[],
): boolean {
  if (skills.length > MAX_MATERIALIZED_SKILLS) return false;
  const capabilities = [...(agent ? [agent] : []), ...skills];
  return (
    capabilities.every(hasMaterializableInstructions) &&
    capabilities.reduce(
      (total, capability) => total + (capability.instructionCharacters ?? 0),
      0,
    ) <= MAX_MATERIALIZED_CAPABILITY_CHARACTERS
  );
}

/** Resolves the exact provider-scoped instructions selected by a validated route. */
export function materializeRouteCapabilities(
  catalog: CapabilityInstructionCatalog,
  route: RouteDecision,
): MaterializedRouteCapabilities {
  if (new Set(route.skills).size !== route.skills.length) {
    throw new Error("Cannot materialize duplicate skill identifiers");
  }
  if (route.skills.length > MAX_MATERIALIZED_SKILLS) {
    throw new Error(`Cannot materialize more than ${MAX_MATERIALIZED_SKILLS} skills`);
  }

  const agent = route.agent
    ? resolveOne(catalog.agents, route.agent, route.provider, "agent")
    : undefined;
  const skills = route.skills.map((id) => resolveOne(catalog.skills, id, route.provider, "skill"));
  if (
    [...(agent ? [agent] : []), ...skills].reduce(
      (total, capability) => total + capability.instructions.length,
      0,
    ) > MAX_MATERIALIZED_CAPABILITY_CHARACTERS
  ) {
    throw new Error(
      `Selected capability instructions exceed ${MAX_MATERIALIZED_CAPABILITY_CHARACTERS} characters`,
    );
  }

  return {
    delivery: "prompt",
    ...(agent ? { agent: instructionRecord(agent) } : {}),
    skills: skills.map(instructionRecord),
  };
}

/** Protects adapters from treating a partial/mismatched marker as successful delivery. */
export function materializationCoversRoute(
  materialized: MaterializedRouteCapabilities | undefined,
  route: RouteDecision,
): boolean {
  if (materialized?.delivery !== "prompt") return false;
  if ((materialized.agent?.id ?? undefined) !== route.agent) return false;
  if (materialized.skills.length !== route.skills.length) return false;
  if (materialized.skills.some((skill, index) => skill.id !== route.skills[index])) return false;
  if (
    [...(materialized.agent ? [materialized.agent] : []), ...materialized.skills].some(
      (capability) =>
        !capability.instructions.trim() ||
        capability.instructions.length > MAX_CAPABILITY_INSTRUCTION_CHARACTERS,
    )
  ) {
    return false;
  }
  return (
    [...(materialized.agent ? [materialized.agent] : []), ...materialized.skills].reduce(
      (total, capability) => total + capability.instructions.length,
      0,
    ) <= MAX_MATERIALIZED_CAPABILITY_CHARACTERS
  );
}

export function promptContainsMaterialization(
  prompt: string,
  materialized: MaterializedRouteCapabilities | undefined,
): boolean {
  if (materialized?.delivery !== "prompt") return false;
  const records = [
    ...(materialized.agent ? [JSON.stringify({ kind: "agent", ...materialized.agent })] : []),
    ...materialized.skills.map((skill) => JSON.stringify({ kind: "skill", ...skill })),
  ];
  return records.every((record) => prompt.includes(record));
}

function resolveOne(
  capabilities: readonly CapabilityInstructionSource[],
  id: string,
  provider: string,
  kind: "agent" | "skill",
): CapabilityInstructionSource {
  const eligible = capabilities.filter(
    (candidate) =>
      candidate.id === id &&
      capabilitySupportsProvider(candidate, provider) &&
      candidate.instructions.trim().length > 0 &&
      candidate.instructions.length <= MAX_CAPABILITY_INSTRUCTION_CHARACTERS,
  );
  if (eligible.length !== 1) {
    const reason = eligible.length === 0 ? "is unavailable" : "is ambiguous";
    throw new Error(`Selected ${kind} ${id} ${reason} for provider ${provider}`);
  }
  return eligible[0] as CapabilityInstructionSource;
}

function instructionRecord(
  capability: CapabilityInstructionSource,
): MaterializedCapabilityInstruction {
  return {
    id: capability.id,
    instructions: capability.instructions.trim(),
  };
}
