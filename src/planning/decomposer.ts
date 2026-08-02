import { randomUUID } from "node:crypto";
import type {
  ArtifactContract,
  ExecutionPlan,
  PlanNode,
  RiskLevel,
  TaskIntent,
  TaskSpec,
} from "../contracts.ts";
import { classifyPrompt } from "../intake/classifier.ts";
import { estimateTokens } from "../utils.ts";
import { assertValidDag } from "./dag.ts";

type NodeKind = "inspect" | "plan" | "execute" | "verify" | "review" | "approval";

interface NodeTemplate {
  key: string;
  title: string;
  objective: string;
  dependencies: string[];
  intent: TaskIntent;
  artifact: ArtifactContract;
  kind: NodeKind;
  weight: number;
  approvalForKey?: string;
}

export interface DecomposeTaskOptions {
  planId?: string;
  createdAt?: string;
  forceSingleStep?: boolean;
  validationCommands?: string[];
  contextRefs?: string[];
}

const CHANGE_INTENTS: readonly TaskIntent[] = ["implement", "fix", "refactor", "optimize", "debug"];
const WORKSPACE_MUTATION_INTENTS: readonly TaskIntent[] = [...CHANGE_INTENTS, "test", "document"];
const ORDERED_ACTION_CONJUNCTIONS = new Set(["and", "then", "e", "depois", "y", "luego"]);

function isCodeChange(intent: TaskIntent): boolean {
  return CHANGE_INTENTS.includes(intent);
}

function mutatesWorkspace(intent: TaskIntent): boolean {
  return WORKSPACE_MUTATION_INTENTS.includes(intent);
}

function taskIntentSequence(task: TaskSpec): TaskIntent[] {
  const sequence = task.intentSequence?.length ? task.intentSequence : [task.intent];
  return [...sequence];
}

function isAsciiWordCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isObjectiveDelimiter(code: number): boolean {
  return code === 0x0a || code === 0x21 || code === 0x2e || code === 0x3b || code === 0x3f;
}

function isEcmaWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function trimOrderedClause(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const code = value.charCodeAt(start);
    if (code !== 0x2c && !isEcmaWhitespace(code)) break;
    start += 1;
  }
  while (end > start) {
    const code = value.charCodeAt(end - 1);
    if (code !== 0x2c && !isEcmaWhitespace(code)) break;
    end -= 1;
  }
  return value.slice(start, end);
}

function splitOrderedActionObjective(objective: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let index = 0;

  const appendSegment = (end: number): void => {
    const segment = trimOrderedClause(objective.slice(segmentStart, end));
    if (segment) segments.push(segment);
  };

  while (index < objective.length) {
    const code = objective.charCodeAt(index);
    if (isObjectiveDelimiter(code)) {
      appendSegment(index);
      index += 1;
      while (index < objective.length && isObjectiveDelimiter(objective.charCodeAt(index))) {
        index += 1;
      }
      segmentStart = index;
      continue;
    }

    if (!isAsciiWordCharacter(code)) {
      index += 1;
      continue;
    }

    const wordStart = index;
    index += 1;
    while (index < objective.length && isAsciiWordCharacter(objective.charCodeAt(index))) {
      index += 1;
    }
    const word = objective.slice(wordStart, index).toLowerCase();
    if (ORDERED_ACTION_CONJUNCTIONS.has(word)) {
      appendSegment(wordStart);
      segmentStart = index;
    }
  }

  appendSegment(objective.length);
  return segments;
}

function orderedActionObjectives(task: TaskSpec, intents: readonly TaskIntent[]): string[] {
  const segments = splitOrderedActionObjective(task.objective);
  const clauses: string[] = [];
  for (const segment of segments) {
    const expectedIntent = intents[clauses.length];
    const startsExpectedAction =
      expectedIntent !== undefined &&
      classifyPrompt(segment).matchedSignals.some((signal) =>
        signal.startsWith(`${expectedIntent}:`),
      );
    if (startsExpectedAction && clauses.length < intents.length) {
      clauses.push(segment);
    } else if (clauses.length > 0) {
      clauses[clauses.length - 1] = `${clauses.at(-1)} ${segment}`;
    } else {
      clauses.push(segment);
    }
  }
  return clauses.length === intents.length
    ? clauses
    : Array.from({ length: intents.length }, () => task.objective);
}

function isComplex(task: TaskSpec): boolean {
  const conjunctions =
    task.objective.match(/\b(?:and|then|also|e|depois|também|y|luego|también)\b/giu)?.length ?? 0;
  return (
    task.riskLevel === "high" ||
    task.riskLevel === "critical" ||
    task.ambiguity >= 0.42 ||
    task.domains.length >= 3 ||
    task.objective.length > 420 ||
    conjunctions >= 2
  );
}

function artifact(type: ArtifactContract["type"], description: string): ArtifactContract {
  return { type, description };
}

function atomicArtifact(task: TaskSpec): ArtifactContract {
  const description = task.deliverables.join("; ") || task.objective;
  if (isCodeChange(task.intent) || task.intent === "test") {
    return artifact("patch", description);
  }
  switch (task.intent) {
    case "review":
    case "security-audit":
      return artifact("review", description);
    case "design":
      return artifact("plan", description);
    case "document":
      return artifact("document", description);
    case "research":
      return artifact("analysis", description);
    default:
      return artifact("result", description);
  }
}

function addApprovalGate(templates: NodeTemplate[], task: TaskSpec): NodeTemplate[] {
  if (!task.requiresHumanApproval) return templates;
  const protectedActions = templates.filter(
    ({ kind, intent }) => kind === "execute" && mutatesWorkspace(intent),
  );
  if (protectedActions.length === 0) {
    const firstExecutable = templates.find(({ kind }) => kind === "execute");
    if (firstExecutable) protectedActions.push(firstExecutable);
  }
  if (protectedActions.length === 0)
    throw new Error("A human approval gate requires an executable stage");

  for (const [approvalIndex, executable] of protectedActions.entries()) {
    const protectedIndex = templates.indexOf(executable);
    const approvalKey = approvalIndex === 0 ? "approval" : `approval-${approvalIndex + 1}`;
    const approval: NodeTemplate = {
      key: approvalKey,
      title: `Obtain human approval for ${executable.title.toLocaleLowerCase("en-US")}`,
      objective: `Present this exact protected action, its target, impact, and rollback; pause until it is approved once. Protected action: ${executable.objective}`,
      dependencies: [...executable.dependencies],
      intent: "review",
      artifact: artifact(
        "review",
        "Approval record bound to one protected action, with impact, target, rollback, and unresolved risk",
      ),
      kind: "approval",
      weight: 0.08,
      approvalForKey: executable.key,
    };
    executable.dependencies = [approvalKey];
    templates.splice(protectedIndex, 0, approval);
  }
  return templates;
}

function orderedActionArtifact(intent: TaskIntent): ArtifactContract {
  switch (intent) {
    case "research":
      return artifact("analysis", "Evidence-backed research for the next requested action");
    case "review":
    case "security-audit":
      return artifact("review", "Prioritized findings backed by precise evidence");
    case "design":
      return artifact("plan", "Implementation-ready design with contracts and trade-offs");
    case "document":
      return artifact("document", "Reviewed documentation change requested by the task");
    case "implement":
    case "fix":
    case "refactor":
    case "optimize":
    case "debug":
    case "test":
      return artifact("patch", `Minimal ${intent} changes required by the objective`);
  }
}

function orderedActionTitle(intent: TaskIntent): string {
  switch (intent) {
    case "research":
      return "Research requested context";
    case "review":
      return "Review current implementation";
    case "security-audit":
      return "Perform security audit";
    case "design":
      return "Design the solution";
    case "test":
      return "Implement focused tests";
    case "document":
      return "Produce requested documentation";
    case "debug":
      return "Diagnose and resolve";
    default:
      return `Execute ${intent}`;
  }
}

function orderedActionWeight(intent: TaskIntent): number {
  if (mutatesWorkspace(intent)) return intent === "test" ? 0.4 : 0.5;
  if (intent === "design") return 0.35;
  return 0.3;
}

function buildOrderedIntentTemplates(
  task: TaskSpec,
  intents: readonly TaskIntent[],
): NodeTemplate[] {
  const templates: NodeTemplate[] = [];
  const actionObjectives = orderedActionObjectives(task, intents);
  let dependency: string | undefined;
  let pendingMutation = false;
  let verificationIndex = 0;

  const addVerification = (): void => {
    if (!pendingMutation || !dependency) return;
    verificationIndex += 1;
    const key = `verify-${verificationIndex}`;
    templates.push({
      key,
      title: "Verify mutated behavior",
      objective:
        "Run the narrowest deterministic checks that prove the preceding mutations and guard against regressions before continuing.",
      dependencies: [dependency],
      intent: "test",
      artifact: artifact(
        "test-report",
        "Commands, results, failures, and coverage of the preceding mutations",
      ),
      kind: "verify",
      weight: 0.22,
    });
    dependency = key;
    pendingMutation = false;
  };

  for (const [index, intent] of intents.entries()) {
    if (!mutatesWorkspace(intent)) addVerification();
    const key = `action-${index + 1}-${intent}`;
    templates.push({
      key,
      title: orderedActionTitle(intent),
      objective: `Perform only this ${intent} action, using prior-stage artifacts as context: ${actionObjectives[index] ?? task.objective}`,
      dependencies: dependency ? [dependency] : [],
      intent,
      artifact: orderedActionArtifact(intent),
      kind: "execute",
      weight: orderedActionWeight(intent),
    });
    dependency = key;
    pendingMutation ||= mutatesWorkspace(intent);
  }
  addVerification();

  const finalIntent = intents.at(-1);
  const needsQualityReview =
    intents.some(mutatesWorkspace) &&
    finalIntent !== "review" &&
    finalIntent !== "security-audit" &&
    (task.riskLevel === "high" || task.riskLevel === "critical" || task.qualityFloor >= 0.92);
  if (needsQualityReview && dependency) {
    templates.push({
      key: "final-review",
      title: "Adversarially review result",
      objective:
        "Review the final diff and deterministic evidence for correctness, security, and unnecessary complexity.",
      dependencies: [dependency],
      intent: "review",
      artifact: artifact("review", "Independent quality-gate decision with actionable findings"),
      kind: "review",
      weight: 0.12,
    });
  }

  return addApprovalGate(templates, task);
}

function buildTemplates(task: TaskSpec, forceSingleStep = false): NodeTemplate[] {
  const complex = isComplex(task);
  const intentSequence = taskIntentSequence(task);
  // A single provider call cannot preserve ordered artifacts or safely place
  // approval and verification boundaries between distinct requested actions.
  if (intentSequence.length > 1) return buildOrderedIntentTemplates(task, intentSequence);
  if (forceSingleStep) {
    return addApprovalGate(
      [
        {
          key: "execute",
          title: `Complete ${task.intent} task`,
          objective: task.objective,
          dependencies: [],
          intent: task.intent,
          artifact: atomicArtifact(task),
          kind: "execute",
          weight: 1,
        },
      ],
      task,
    );
  }
  if (!complex && ["document", "research"].includes(task.intent)) {
    return addApprovalGate(
      [
        {
          key: "execute",
          title: `Complete ${task.intent} task`,
          objective: task.objective,
          dependencies: [],
          intent: task.intent,
          artifact: atomicArtifact(task),
          kind: "execute",
          weight: 1,
        },
      ],
      task,
    );
  }

  const templates: NodeTemplate[] = [];
  const add = (template: NodeTemplate): void => {
    templates.push(template);
  };

  add({
    key: "inspect",
    title: "Inspect relevant context",
    objective: `Locate the smallest authoritative context needed for: ${task.objective}`,
    dependencies: [],
    intent: "research",
    artifact: artifact(
      "analysis",
      "Evidence map with relevant files, symbols, facts, and constraints",
    ),
    kind: "inspect",
    weight: 0.15,
  });

  if (task.intent === "review" || task.intent === "security-audit") {
    add({
      key: "execute",
      title: task.intent === "security-audit" ? "Perform security audit" : "Perform focused review",
      objective: task.objective,
      dependencies: ["inspect"],
      intent: task.intent,
      artifact: artifact("review", "Prioritized findings backed by precise evidence"),
      kind: "execute",
      weight: 0.58,
    });
    add({
      key: "verify",
      title: "Validate findings",
      objective:
        "Challenge the findings, remove unsupported claims, and confirm severity and remediation.",
      dependencies: ["execute"],
      intent: "review",
      artifact: artifact("review", "Independently validated final findings"),
      kind: "verify",
      weight: 0.27,
    });
  } else if (task.intent === "design") {
    add({
      key: "execute",
      title: "Design the solution",
      objective: task.objective,
      dependencies: ["inspect"],
      intent: "design",
      artifact: artifact("plan", "Implementation-ready architecture with contracts and trade-offs"),
      kind: "execute",
      weight: 0.62,
    });
    add({
      key: "review",
      title: "Review design",
      objective:
        "Verify feasibility, simplicity, security, cost, and coverage of the acceptance criteria.",
      dependencies: ["execute"],
      intent: "review",
      artifact: artifact("review", "Validated design and any required corrections"),
      kind: "review",
      weight: 0.23,
    });
  } else if (task.intent === "test") {
    add({
      key: "execute",
      title: "Implement focused tests",
      objective: task.objective,
      dependencies: ["inspect"],
      intent: "test",
      artifact: artifact("patch", "Minimal test changes covering the requested behavior"),
      kind: "execute",
      weight: 0.58,
    });
    add({
      key: "verify",
      title: "Run and verify tests",
      objective: "Execute the relevant checks and distinguish product failures from test defects.",
      dependencies: ["execute"],
      intent: "test",
      artifact: artifact("test-report", "Reproducible validation results"),
      kind: "verify",
      weight: 0.27,
    });
  } else if (isCodeChange(task.intent)) {
    let executionDependency = "inspect";
    if (complex) {
      add({
        key: "plan",
        title: "Plan minimal change",
        objective:
          "Define the smallest safe implementation that satisfies every acceptance criterion.",
        dependencies: ["inspect"],
        intent: "design",
        artifact: artifact(
          "plan",
          "Scoped implementation plan with risks and verification strategy",
        ),
        kind: "plan",
        weight: 0.12,
      });
      executionDependency = "plan";
    }
    add({
      key: "execute",
      title: task.intent === "debug" ? "Diagnose and resolve" : `Execute ${task.intent}`,
      objective: task.objective,
      dependencies: [executionDependency],
      intent: task.intent,
      artifact: artifact("patch", "Minimal source changes required by the objective"),
      kind: "execute",
      weight: complex ? 0.45 : 0.58,
    });
    add({
      key: "verify",
      title: "Verify behavior",
      objective:
        "Run the narrowest deterministic checks that prove the change and guard against regressions.",
      dependencies: ["execute"],
      intent: "test",
      artifact: artifact(
        "test-report",
        "Commands, results, failures, and coverage of acceptance criteria",
      ),
      kind: "verify",
      weight: 0.22,
    });
    if (task.riskLevel === "high" || task.riskLevel === "critical" || task.qualityFloor >= 0.92) {
      add({
        key: "review",
        title: "Adversarially review result",
        objective:
          "Review the diff and validation evidence for correctness, security, and unnecessary complexity.",
        dependencies: ["verify"],
        intent: "review",
        artifact: artifact("review", "Independent quality-gate decision with actionable findings"),
        kind: "review",
        weight: 0.12,
      });
    }
  } else {
    add({
      key: "execute",
      title: `Execute ${task.intent}`,
      objective: task.objective,
      dependencies: ["inspect"],
      intent: task.intent,
      artifact: artifact(
        task.intent === "document" ? "document" : "result",
        task.deliverables.join("; "),
      ),
      kind: "execute",
      weight: 0.62,
    });
    add({
      key: "review",
      title: "Validate final result",
      objective:
        "Check the result against the objective, constraints, sources, and acceptance criteria.",
      dependencies: ["execute"],
      intent: "review",
      artifact: artifact("review", "Validated result ready for delivery"),
      kind: "review",
      weight: 0.23,
    });
  }

  return addApprovalGate(templates, task);
}

function requiredTools(kind: NodeKind, intent: TaskIntent): string[] {
  // Approval and planning consume bounded handoffs. Review stages must inspect
  // the current workspace and diff directly, but never receive write tools.
  if (kind === "approval" || kind === "plan") return [];
  if (kind === "review" || intent === "review") return ["Read", "Glob", "Grep"];
  if (kind === "verify") return [];
  if (kind === "inspect" || intent === "research" || intent === "security-audit") {
    return ["Read", "Glob", "Grep"];
  }
  if (intent === "design") return ["Read", "Glob", "Grep"];
  if (intent === "document") return ["Read", "Glob", "Grep", "Edit"];
  // Provider agents receive only bounded repository tools. Deterministic commands
  // run later through the verification runner's separate allowlist and budget.
  return ["Read", "Glob", "Grep", "Edit", "Write"];
}

function stepRisk(taskRisk: RiskLevel, kind: NodeKind): RiskLevel {
  if (kind === "execute" || kind === "approval") return taskRisk;
  if (taskRisk === "critical") return "high";
  if (taskRisk === "high") return "medium";
  return taskRisk;
}

function minimumStepQuality(task: TaskSpec, kind: NodeKind): number {
  const discount = kind === "inspect" ? 0.08 : kind === "plan" ? 0.04 : 0;
  return Math.max(0.7, Math.min(1, task.qualityFloor - discount));
}

function estimatedBasePromptTokens(task: TaskSpec, template: NodeTemplate): number {
  const objectives = template.objective.includes(task.objective)
    ? template.objective
    : `${task.objective}\n${template.objective}`;
  const contract = [
    objectives,
    template.title,
    template.artifact.type,
    template.artifact.description,
    ...task.constraints,
    ...task.acceptanceCriteria.map(({ description }) => description),
  ].join("\n");
  // Covers the invariant route, safety, and completion headers added later.
  return Math.max(64, estimateTokens(contract) + 384);
}

function allocateInputBudgets(
  task: TaskSpec,
  templates: readonly NodeTemplate[],
): { bases: number[]; budgets: number[] } {
  const bases = templates.map((template) => estimatedBasePromptTokens(task, template));
  const required = bases.reduce((sum, value) => sum + value, 0);
  if (required > task.budget.maxInputTokens) {
    throw new Error(
      `Input-token budget cannot support this ${templates.length}-stage plan: at least ${required} tokens are required before dependency or capability context, but the task budget is ${task.budget.maxInputTokens}`,
    );
  }
  const remaining = task.budget.maxInputTokens - required;
  const totalWeight = templates.reduce((sum, template) => sum + template.weight, 0);
  return {
    bases,
    budgets: templates.map(
      (template, index) =>
        (bases[index] ?? 0) + Math.floor(remaining * (template.weight / totalWeight)),
    ),
  };
}

/**
 * Produces a token-aware DAG. It deliberately keeps trivial research and
 * documentation as one node; agent fan-out has to earn its context overhead.
 */
export function decomposeTask(task: TaskSpec, options: DecomposeTaskOptions = {}): ExecutionPlan {
  let templates = buildTemplates(task, options.forceSingleStep);
  let inputAllocation: { bases: number[]; budgets: number[] };
  try {
    inputAllocation = allocateInputBudgets(task, templates);
  } catch (error) {
    const canCollapseWithoutLosingRequestedActions =
      !options.forceSingleStep &&
      !task.requiresHumanApproval &&
      taskIntentSequence(task).length === 1 &&
      templates.length > 1;
    if (!canCollapseWithoutLosingRequestedActions) throw error;
    templates = buildTemplates(task, true);
    inputAllocation = allocateInputBudgets(task, templates);
  }
  const totalWeight = templates.reduce((sum, template) => sum + template.weight, 0);
  if (task.budget.maxOutputTokens < templates.length) {
    throw new Error(
      `Output-token budget ${task.budget.maxOutputTokens} cannot support ${templates.length} stages`,
    );
  }
  const distributableOutputTokens = task.budget.maxOutputTokens - templates.length;
  const outputBudgets = templates.map(
    (template) => 1 + Math.floor(distributableOutputTokens * (template.weight / totalWeight)),
  );
  const idByKey = new Map(
    templates.map((template, index) => [template.key, `${index + 1}-${template.key}`]),
  );
  const commands =
    options.validationCommands ??
    task.acceptanceCriteria.flatMap((criterion) =>
      criterion.kind === "command" && criterion.command ? [criterion.command] : [],
    );

  const nodes: PlanNode[] = templates.map((template, templateIndex) => {
    const id = idByKey.get(template.key);
    if (!id) throw new Error(`Planner failed to assign id for ${template.key}`);
    const allocation = template.weight / totalWeight;
    const contextBudget = inputAllocation.budgets[templateIndex] ?? 0;
    const expectedInputTokens = inputAllocation.bases[templateIndex] ?? 0;
    const totalNodeOutputBudget = outputBudgets[templateIndex] ?? 1;
    const maxAttempts = Math.max(
      1,
      Math.min(
        task.budget.maxAttempts,
        template.kind === "approval" ? 1 : 2,
        totalNodeOutputBudget,
      ),
    );
    // `outputBudget` is a hard per-attempt ceiling. Divide the node's share by
    // its retry allowance so the complete retry ladder remains inside the
    // task-wide output budget even when a provider consumes every allowance.
    const outputBudget = Math.max(1, Math.floor(totalNodeOutputBudget / maxAttempts));
    const qualityFloor = minimumStepQuality(task, template.kind);
    const riskLevel = stepRisk(task.riskLevel, template.kind);
    const approvalForNodeId = template.approvalForKey
      ? idByKey.get(template.approvalForKey)
      : undefined;
    if (template.approvalForKey && !approvalForNodeId) {
      throw new Error(`Planner referenced unknown approval target ${template.approvalForKey}`);
    }

    return {
      id,
      title: template.title,
      objective: template.objective,
      dependencies: template.dependencies.map((dependency) => {
        const resolved = idByKey.get(dependency);
        if (!resolved)
          throw new Error(`Planner referenced unknown template dependency ${dependency}`);
        return resolved;
      }),
      expectedArtifact: template.artifact,
      riskLevel,
      qualityFloor,
      routeRequest: {
        stepId: id,
        taskIntent: template.intent,
        domains: [...task.domains],
        riskLevel,
        qualityFloor,
        expectedInputTokens,
        maxInputTokens: contextBudget,
        expectedOutputTokens: outputBudget,
        maxLatencyMs: task.budget.maxDurationMs,
        requiredTools: requiredTools(template.kind, template.intent),
      },
      contextRefs: [...(options.contextRefs ?? [])],
      contextBudget,
      outputBudget,
      maxCostUsd: task.budget.maxCostUsd * allocation,
      maxAttempts,
      verification: {
        commands:
          template.kind === "verify" ||
          (templates.length === 1 && template.artifact.type === "patch")
            ? [...commands]
            : [],
        // A review template is already a separate, ephemeral provider call. This
        // flag is reserved for caller-supplied plans that require an additional
        // verifier beyond an explicit review node.
        requireIndependentReview: false,
        ...(template.kind === "review" ||
        (template.kind === "verify" && template.artifact.type === "review")
          ? { reviewVerdictRequired: true }
          : {}),
        requireHumanApproval: template.kind === "approval",
        ...(approvalForNodeId ? { approvalForNodeId } : {}),
        minimumScore: qualityFloor,
      },
    };
  });

  assertValidDag(nodes);
  const explanation = [
    templates.length === 1
      ? "Kept the task atomic because decomposition overhead would exceed its expected benefit."
      : `Decomposed the task into ${templates.length} dependency-aware stages.`,
    "Budgets are allocated by stage weight and every stage has an explicit artifact contract.",
  ];
  if (task.requiresHumanApproval)
    explanation.push("Added a mandatory human gate before the requested high-impact action.");
  const intentSequence = taskIntentSequence(task);
  if (intentSequence.length > 1) {
    explanation.push(`Preserved ordered intent sequence: ${intentSequence.join(" -> ")}.`);
  }

  return {
    id: options.planId ?? randomUUID(),
    task,
    nodes,
    createdAt: options.createdAt ?? new Date().toISOString(),
    predictedPrimaryCallCostUsd: 0,
    explanation,
  };
}

export const createExecutionPlan = decomposeTask;
