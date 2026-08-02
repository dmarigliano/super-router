import { randomUUID } from "node:crypto";
import { defaultConfig } from "../config.ts";
import type {
  AcceptanceCriterion,
  Budget,
  RouterConfig,
  TaskIntent,
  TaskSpec,
} from "../contracts.ts";
import { classifyPrompt, type PromptClassification } from "./classifier.ts";

const RISK_QUALITY_FLOOR = {
  low: 0.78,
  medium: 0.84,
  high: 0.9,
  critical: 0.95,
} as const;

export interface CreateTaskSpecOptions {
  id?: string;
  config?: RouterConfig;
  classification?: PromptClassification;
  objective?: string;
  intent?: TaskIntent;
  intentSequence?: TaskIntent[];
  qualityFloor?: number;
  budget?: Partial<Budget>;
  constraints?: string[];
  deliverables?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  privacy?: TaskSpec["privacy"];
  requiresHumanApproval?: boolean;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(compactWhitespace).filter(Boolean))];
}

function extractConstraints(prompt: string): string[] {
  const clauses = prompt
    .split(/(?<=[.!?;\n])\s+/u)
    .map(compactWhitespace)
    .filter(Boolean);
  const constraintPattern =
    /\b(?:must|must not|without|only|do not|never|should not|tem que|deve|não|sem|somente|apenas|nunca|tiene que|debe|sin|solo|solamente|nunca)\b/iu;
  return clauses.filter((clause) => constraintPattern.test(clause)).slice(0, 12);
}

function defaultDeliverables(intent: TaskIntent): string[] {
  switch (intent) {
    case "implement":
    case "fix":
    case "refactor":
    case "optimize":
      return ["Verified code change", "Validation summary"];
    case "test":
      return ["Automated tests", "Test report"];
    case "review":
    case "security-audit":
      return ["Prioritized findings with evidence", "Recommended remediations"];
    case "research":
      return ["Evidence-backed analysis", "Actionable recommendation"];
    case "design":
      return ["Implementation-ready design", "Risks and trade-offs"];
    case "document":
      return ["Reviewed documentation artifact"];
    case "debug":
      return ["Root-cause diagnosis", "Verified resolution or next action"];
  }
}

function compactIntentSequence(values: readonly TaskIntent[]): TaskIntent[] {
  return [...values];
}

function defaultAcceptanceCriteria(
  intents: readonly TaskIntent[],
  requiresHumanApproval: boolean,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [
    {
      id: "deliverables-present",
      description:
        "Every planned expected-artifact contract is present and passes its verification policy.",
      kind: "artifact",
      required: true,
    },
  ];

  if (
    intents.some((intent) =>
      ["implement", "fix", "refactor", "optimize", "test", "debug", "document"].includes(intent),
    )
  ) {
    criteria.push({
      id: "automated-validation",
      description:
        "Every configured deterministic check passes; if none is discovered, the plan reports that no command evidence is available.",
      kind: "policy",
      required: true,
    });
  }
  if (requiresHumanApproval) {
    criteria.push({
      id: "human-approval",
      description:
        "A human approves the external, destructive, or critical action before it is performed.",
      kind: "human",
      required: true,
    });
  }
  return criteria;
}

function mergeBudget(base: Budget, override: Partial<Budget> | undefined): Budget {
  const budget = { ...base, ...override };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`budget.${key} must be greater than zero`);
  }
  return budget;
}

/** Builds the durable, provider-neutral contract consumed by the planner. */
export function createTaskSpec(prompt: string, options: CreateTaskSpecOptions = {}): TaskSpec {
  const objective = compactWhitespace(options.objective ?? prompt);
  if (!objective) throw new Error("A non-empty task objective is required");

  const config = options.config ?? defaultConfig;
  const classification = options.classification ?? classifyPrompt(prompt);
  const intent = options.intent ?? options.intentSequence?.[0] ?? classification.intent;
  const classifiedSequence = classification.intentSequence ?? [classification.intent];
  const requestedSequence =
    options.intentSequence ?? (options.intent === undefined ? classifiedSequence : [intent]);
  const intentSequence = compactIntentSequence(
    requestedSequence[0] === intent ? requestedSequence : [intent, ...requestedSequence],
  );
  const requiresHumanApproval =
    classification.requiresHumanApproval || options.requiresHumanApproval === true;
  const requestedQuality = options.qualityFloor ?? config.qualityFloor;
  if (!Number.isFinite(requestedQuality) || requestedQuality < 0 || requestedQuality > 1) {
    throw new Error("qualityFloor must be between 0 and 1");
  }

  return {
    id: options.id ?? randomUUID(),
    objective,
    intent,
    intentSequence,
    domains: [...classification.domains],
    languages: [...classification.languages],
    riskLevel: classification.riskLevel,
    ambiguity: classification.ambiguity,
    qualityFloor: Math.max(requestedQuality, RISK_QUALITY_FLOOR[classification.riskLevel]),
    constraints: unique([
      ...(options.constraints ?? []),
      ...extractConstraints(prompt),
      ...(classification.ambiguity >= 0.75 && options.intent === undefined
        ? [
            "High-ambiguity request: remain read-only and request clarification before any modification.",
          ]
        : []),
    ]),
    deliverables: unique(
      options.deliverables ??
        intentSequence.flatMap((sequenceIntent) => defaultDeliverables(sequenceIntent)),
    ),
    acceptanceCriteria: options.acceptanceCriteria
      ? [...options.acceptanceCriteria]
      : defaultAcceptanceCriteria(intentSequence, requiresHumanApproval),
    budget: mergeBudget(config.budget, options.budget),
    privacy: options.privacy ?? (config.memory.enabled ? "local-memory" : "ephemeral"),
    requiresHumanApproval,
  };
}
