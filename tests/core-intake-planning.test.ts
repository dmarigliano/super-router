import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import type { PlanNode, TaskSpec } from "../src/contracts.ts";
import {
  classifyPrompt,
  normalizePromptText,
  type PromptClassification,
  tokenizePrompt,
} from "../src/intake/classifier.ts";
import { createTaskSpec } from "../src/intake/task-spec.ts";
import { topologicalSort, validateDag } from "../src/planning/dag.ts";
import { decomposeTask } from "../src/planning/decomposer.ts";
import { estimateTokens } from "../src/utils.ts";

function classification(overrides: Partial<PromptClassification> = {}): PromptClassification {
  return {
    intent: "implement",
    intentSequence: ["implement"],
    domains: ["general"],
    languages: ["en"],
    riskLevel: "low",
    complexity: "simple",
    confidence: 0.95,
    ambiguity: 0.05,
    requiresHumanApproval: false,
    matchedSignals: ["implement:implement"],
    intentScores: {
      implement: 3,
      fix: 0,
      review: 0,
      research: 0,
      design: 0,
      refactor: 0,
      test: 0,
      document: 0,
      optimize: 0,
      "security-audit": 0,
      debug: 0,
    },
    ...overrides,
  };
}

function task(
  overrides: Partial<TaskSpec> = {},
  prompt = "Implement the requested behavior",
): TaskSpec {
  return createTaskSpec(prompt, {
    id: "task-1",
    classification: classification(),
    budget: {
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostUsd: 2,
      maxDurationMs: 30_000,
      maxAttempts: 3,
    },
    ...("intent" in overrides ? { intent: overrides.intent } : {}),
    ...("qualityFloor" in overrides ? { qualityFloor: overrides.qualityFloor } : {}),
    ...("requiresHumanApproval" in overrides
      ? { requiresHumanApproval: overrides.requiresHumanApproval }
      : {}),
    ...("privacy" in overrides ? { privacy: overrides.privacy } : {}),
    ...("constraints" in overrides ? { constraints: overrides.constraints } : {}),
    ...("deliverables" in overrides ? { deliverables: overrides.deliverables } : {}),
    ...("acceptanceCriteria" in overrides
      ? { acceptanceCriteria: overrides.acceptanceCriteria }
      : {}),
  });
}

describe("multilingual prompt classification", () => {
  test("estimates multilingual and code-heavy prompts conservatively", () => {
    expect(estimateTokens("a".repeat(400))).toBeGreaterThan(100);
    expect(estimateTokens("漢字".repeat(100))).toBeGreaterThanOrEqual(300);
    expect(estimateTokens("😀".repeat(100))).toBeGreaterThanOrEqual(200);
    expect(estimateTokens("{}[]();,:=".repeat(20))).toBe(200);
  });

  test("normalizes Unicode accents and tokenizes on complete words", () => {
    expect(normalizePromptText("  Autenticação, PRODUÇÃO!  ")).toBe("autenticacao producao");
    expect(tokenizePrompt("Crie uma API segura.")).toEqual(["crie", "uma", "api", "segura"]);
  });

  test.each([
    ["Corrija o bug na autenticação sem alterar a API pública.", "fix", "pt"],
    ["Please review the backend service and its API.", "review", "en"],
    ["Documente la arquitectura para el equipo.", "document", "es"],
  ] as const)("classifies %s", (prompt, intent, language) => {
    const result = classifyPrompt(prompt);
    expect(result.intent).toBe(intent);
    expect(result.languages).toContain(language);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test("does not turn nouns or substrings into explicit action intents", () => {
    const failingTests = classifyPrompt("Tests are failing in the app");
    const catalog = classifyPrompt("catalog processing approach");

    expect(failingTests.intent).not.toBe("test");
    expect(failingTests.intentScores.test).toBe(0);
    expect(catalog.matchedSignals).toEqual([]);
    expect(catalog.ambiguity).toBe(1);
  });

  test("defaults prompts without an action signal to read-only research", () => {
    const classification = classifyPrompt("Qual é a causa deste comportamento?");
    const spec = createTaskSpec("Qual é a causa deste comportamento?", { classification });

    expect(classification.intent).toBe("research");
    expect(classification.ambiguity).toBeGreaterThanOrEqual(0.75);
    expect(spec.constraints).toContain(
      "High-ambiguity request: remain read-only and request clarification before any modification.",
    );
    const plan = decomposeTask(spec);
    expect(
      plan.nodes.every(({ routeRequest }) => !routeRequest.requiredTools.includes("Edit")),
    ).toBe(true);
    expect(
      plan.nodes.every(({ routeRequest }) => !routeRequest.requiredTools.includes("Write")),
    ).toBe(true);
  });

  test("classifies administrator permission mutations as critical", () => {
    const classification = classifyPrompt("Altere as permissões de acesso dos administradores");
    expect(classification.intent).toBe("implement");
    expect(classification.riskLevel).toBe("critical");
    expect(classification.requiresHumanApproval).toBe(true);
  });

  test("detects critical, external, and destructive operations", () => {
    const result = classifyPrompt(
      "Deploy to production and delete production data after the migration.",
    );

    expect(result.riskLevel).toBe("critical");
    expect(result.complexity).toBe("systemic");
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.matchedSignals).toContain("external:deploy");
    expect(result.matchedSignals).toContain("destructive:delete");
  });

  test("raises security and authentication risk without inventing an approval", () => {
    const result = classifyPrompt("Corrija o bug na autenticação da API.");
    expect(result.domains).toEqual(expect.arrayContaining(["backend", "security"]));
    expect(result.riskLevel).toBe("high");
    expect(result.requiresHumanApproval).toBe(false);
  });

  test("uses the first explicit action as the primary intent for multi-action prompts", () => {
    const result = classifyPrompt("Diseñe la arquitectura y luego implemente el endpoint.");
    expect(result.intent).toBe("design");
    expect(result.intentSequence).toEqual(["design", "implement"]);
    expect(result.intentScores.design).toBeGreaterThan(result.intentScores.implement);
    expect(result.ambiguity).toBeGreaterThan(0.4);

    const fixWithTests = classifyPrompt("Corrija o timeout do login e adicione testes");
    expect(fixWithTests.intent).toBe("fix");
    expect(fixWithTests.intentSequence).toEqual(["fix", "test"]);
    expect(fixWithTests.intentSequence).not.toContain("implement");
    expect(fixWithTests.intentScores.test).toBeGreaterThan(0);

    const reviewFixReview = classifyPrompt(
      "Review the backend, then fix the bug, then review the result",
    );
    expect(reviewFixReview.intentSequence).toEqual(["review", "fix", "review"]);
  });

  test.each([
    [
      "Implement login endpoint, then implement logout endpoint",
      "implement",
      ["login endpoint", "logout endpoint"],
    ],
    ["Corrija bug login e depois corrija bug logout", "fix", ["bug login", "bug logout"]],
  ] as const)("preserves repeated ordered actions in %s", (prompt, intent, targets) => {
    const promptClassification = classifyPrompt(prompt);
    const spec = createTaskSpec(prompt, { classification: promptClassification });
    const plan = decomposeTask(spec, { validationCommands: ["bun test"] });
    const actions = plan.nodes.filter(({ id }) => id.includes("-action-"));

    expect(promptClassification.intentSequence).toEqual([intent, intent]);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.objective).toContain(targets[0]);
    expect(actions[0]?.objective).not.toContain(targets[1]);
    expect(actions[1]?.objective).toContain(targets[1]);
  });

  test("deduplicates same-intent synonyms inside one clause to avoid duplicate effects", () => {
    const prompt = "Implement and deploy a payment migration to production";
    const promptClassification = classifyPrompt(prompt);
    const spec = createTaskSpec(prompt, { classification: promptClassification });
    const plan = decomposeTask(spec);

    expect(promptClassification.intentSequence).toEqual(["implement"]);
    expect(plan.nodes.filter(({ id }) => id.includes("-action-"))).toHaveLength(0);
    expect(plan.nodes.filter(({ verification }) => verification.requireHumanApproval)).toHaveLength(
      1,
    );
  });

  test.each([
    ["Review the backend. Fix the login bug", ["backend", "login bug"]],
    ["Corrija o login e adicione testes", ["login", "testes"]],
  ] as const)("scopes ordered action objectives in %s", (prompt, targets) => {
    const spec = createTaskSpec(prompt);
    const plan = decomposeTask(spec);
    const actions = plan.nodes.filter(({ id }) => id.includes("-action-"));

    expect(actions).toHaveLength(2);
    expect(actions[0]?.objective).toContain(targets[0]);
    expect(actions[0]?.objective).not.toContain(targets[1]);
    expect(actions[1]?.objective).toContain(targets[1]);
  });
});

describe("TaskSpec contracts", () => {
  test.each([
    ["low", 0.78],
    ["medium", 0.84],
    ["high", 0.9],
    ["critical", 0.95],
  ] as const)("enforces the %s risk quality floor", (riskLevel, expectedFloor) => {
    const spec = createTaskSpec("Implement it", {
      id: "quality-floor",
      qualityFloor: 0.1,
      classification: classification({ riskLevel }),
    });
    expect(spec.qualityFloor).toBe(expectedFloor);
  });

  test("compacts the objective, extracts constraints, and deduplicates inputs", () => {
    const spec = createTaskSpec(
      "  Implement   the API. It must not log secrets. Use only native APIs.  ",
      {
        id: "normalized",
        classification: classification(),
        constraints: ["It must not log secrets.", "  It must not log secrets.  "],
        deliverables: ["Patch", " Patch "],
      },
    );

    expect(spec.objective).toBe(
      "Implement the API. It must not log secrets. Use only native APIs.",
    );
    expect(spec.constraints).toEqual(["It must not log secrets.", "Use only native APIs."]);
    expect(spec.deliverables).toEqual(["Patch"]);
  });

  test("preserves secondary test work as an explicit deliverable", () => {
    const spec = createTaskSpec("Corrija o timeout do login e adicione testes");
    expect(spec.intent).toBe("fix");
    expect(spec.intentSequence).toEqual(["fix", "test"]);
    expect(spec.deliverables).toEqual(
      expect.arrayContaining(["Verified code change", "Automated tests", "Test report"]),
    );
  });

  test("merges positive budget overrides and leaves other limits unchanged", () => {
    const spec = createTaskSpec("Implement it", {
      id: "budget",
      classification: classification(),
      budget: { maxCostUsd: 0.25, maxAttempts: 1 },
    });

    expect(spec.budget.maxCostUsd).toBe(0.25);
    expect(spec.budget.maxAttempts).toBe(1);
    expect(spec.budget.maxInputTokens).toBeGreaterThan(1_000);
  });

  test("adds automation and human approval acceptance criteria", () => {
    const spec = createTaskSpec("Delete production data", {
      id: "approval",
      classification: classification({
        riskLevel: "critical",
        requiresHumanApproval: true,
      }),
    });
    expect(spec.requiresHumanApproval).toBe(true);
    expect(spec.acceptanceCriteria.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["automated-validation", "human-approval"]),
    );
  });

  test("defaults to ephemeral privacy when memory is disabled", () => {
    const config = structuredClone(defaultConfig);
    config.memory.enabled = false;
    const spec = createTaskSpec("Implement it", {
      id: "private",
      config,
      classification: classification(),
    });
    expect(spec.privacy).toBe("ephemeral");
  });

  test("rejects invalid objectives, quality floors, and budgets", () => {
    expect(() => createTaskSpec("  ", { classification: classification() })).toThrow(
      "non-empty task objective",
    );
    expect(() =>
      createTaskSpec("Implement it", {
        qualityFloor: 1.1,
        classification: classification(),
      }),
    ).toThrow("qualityFloor must be between 0 and 1");
    expect(() =>
      createTaskSpec("Implement it", {
        budget: { maxCostUsd: 0 },
        classification: classification(),
      }),
    ).toThrow("budget.maxCostUsd must be greater than zero");
  });
});

describe("dependency-aware planning", () => {
  test("keeps simple documentation atomic to avoid orchestration overhead", () => {
    const spec = createTaskSpec("Documente o README", {
      id: "docs",
      intent: "document",
      classification: classification({
        intent: "document",
        languages: ["pt"],
      }),
      budget: {
        maxInputTokens: 1_000,
        maxOutputTokens: 500,
        maxCostUsd: 1,
        maxAttempts: 2,
      },
    });
    const plan = decomposeTask(spec, {
      planId: "plan-docs",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]?.expectedArtifact.type).toBe("document");
    expect(plan.explanation[0]).toContain("atomic");
  });

  test("keeps forced atomic code work as a verified patch", () => {
    const atomic = decomposeTask(task(), {
      forceSingleStep: true,
      validationCommands: ["bun test", "bun run typecheck"],
    });
    const node = atomic.nodes[0];

    expect(atomic.nodes).toHaveLength(1);
    expect(node?.expectedArtifact.type).toBe("patch");
    expect(node?.verification.commands).toEqual(["bun test", "bun run typecheck"]);
    expect(node?.routeRequest.requiredTools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "Edit", "Write"]),
    );
  });

  test.each([
    ["review", "review"],
    ["security-audit", "review"],
    ["design", "plan"],
    ["document", "document"],
    ["test", "patch"],
  ] as const)("preserves the %s artifact contract when forced atomic", (intent, artifactType) => {
    const atomic = decomposeTask(task({ intent }, `Complete a focused ${intent} task`), {
      forceSingleStep: true,
    });

    expect(atomic.nodes).toHaveLength(1);
    expect(atomic.nodes[0]?.expectedArtifact.type).toBe(artifactType);
  });

  test("builds an ordered change DAG and wires validation only to verification", () => {
    const plan = decomposeTask(task(), {
      planId: "plan-change",
      createdAt: "2026-01-01T00:00:00.000Z",
      validationCommands: ["bun test", "bun run typecheck"],
      contextRefs: ["src/index.ts"],
    });
    const validation = validateDag(plan.nodes);

    expect(validation.valid).toBe(true);
    expect(validation.topologicalOrder).toEqual(plan.nodes.map(({ id }) => id));
    expect(plan.nodes.map(({ title }) => title)).toEqual([
      "Inspect relevant context",
      "Execute implement",
      "Verify behavior",
    ]);
    const verify = plan.nodes.find(({ id }) => id.endsWith("-verify"));
    expect(verify?.verification.commands).toEqual(["bun test", "bun run typecheck"]);
    expect(
      plan.nodes
        .filter((node) => node !== verify)
        .every((node: PlanNode) => node.verification.commands.length === 0),
    ).toBe(true);
    expect(plan.nodes.every(({ contextRefs }) => contextRefs[0] === "src/index.ts")).toBe(true);
    expect(plan.nodes.find(({ id }) => id.endsWith("-inspect"))?.maxAttempts).toBe(2);
  });

  test.each([
    {
      prompt: "Research caching options, then implement the backend endpoint",
      sequence: ["research", "implement"],
      actionArtifacts: ["analysis", "patch"],
    },
    {
      prompt: "Review the backend endpoint, then fix the bug",
      sequence: ["review", "fix"],
      actionArtifacts: ["review", "patch"],
    },
    {
      prompt: "Design the backend service, then implement it",
      sequence: ["design", "implement"],
      actionArtifacts: ["plan", "patch"],
    },
  ] as const)(
    "preserves ordered $sequence actions through planning",
    ({ prompt, sequence, actionArtifacts }) => {
      const spec = createTaskSpec(prompt, {
        id: "ordered-intents",
        budget: {
          maxInputTokens: 8_000,
          maxOutputTokens: 2_000,
          maxCostUsd: 2,
          maxDurationMs: 30_000,
          maxAttempts: 3,
        },
      });
      const plan = decomposeTask(spec, {
        forceSingleStep: true,
        validationCommands: ["bun test"],
      });
      const actions = plan.nodes.filter(({ id }) => id.includes("-action-"));
      const verify = plan.nodes.find(
        ({ expectedArtifact }) => expectedArtifact.type === "test-report",
      );
      const firstAction = actions[0];
      const secondAction = actions[1];
      if (!firstAction || !secondAction || !verify) {
        throw new Error("ordered intent fixture did not produce two actions and verification");
      }

      expect(spec.intentSequence).toEqual([...sequence]);
      expect(actions.map(({ routeRequest }) => routeRequest.taskIntent)).toEqual([...sequence]);
      expect(actions.map(({ expectedArtifact }) => expectedArtifact.type)).toEqual([
        ...actionArtifacts,
      ]);
      expect(actions.map(({ dependencies }) => dependencies)).toEqual([[], [firstAction.id]]);
      expect(verify.dependencies).toEqual([secondAction.id]);
      expect(verify.verification.commands).toEqual(["bun test"]);
      expect(firstAction.routeRequest.requiredTools).toEqual(
        expect.arrayContaining(["Read", "Glob", "Grep"]),
      );
      expect(secondAction.routeRequest.requiredTools).toEqual(
        expect.arrayContaining(["Edit", "Write"]),
      );
      expect(validateDag(plan.nodes).valid).toBe(true);
    },
  );

  test("places approval immediately before the first protected ordered action", () => {
    const spec = createTaskSpec("Research deployment options, then deploy to production", {
      id: "ordered-approval",
      budget: {
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        maxCostUsd: 2,
        maxDurationMs: 30_000,
        maxAttempts: 3,
      },
    });
    const plan = decomposeTask(spec, { validationCommands: ["bun test"] });
    const research = plan.nodes.find(({ routeRequest }) => routeRequest.taskIntent === "research");
    const approval = plan.nodes.find(({ id }) => id.endsWith("-approval"));
    const mutation = plan.nodes.find(
      ({ routeRequest, expectedArtifact }) =>
        routeRequest.taskIntent === "implement" && expectedArtifact.type === "patch",
    );
    if (!research || !approval || !mutation) {
      throw new Error("ordered approval fixture is incomplete");
    }

    expect(spec.requiresHumanApproval).toBe(true);
    expect(approval.dependencies).toEqual([research.id]);
    expect(mutation.dependencies).toEqual([approval.id]);
    expect(approval.verification.requireHumanApproval).toBe(true);
    expect(approval.verification.approvalForNodeId).toBe(mutation.id);
  });

  test("binds a separate one-time approval gate to each protected ordered action", () => {
    const spec = createTaskSpec("Deploy to production, then add tests", {
      id: "ordered-approval-bindings",
      budget: {
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        maxCostUsd: 2,
        maxDurationMs: 30_000,
        maxAttempts: 3,
      },
    });
    const plan = decomposeTask(spec, { validationCommands: ["bun test"] });
    const approvals = plan.nodes.filter(({ verification }) => verification.requireHumanApproval);
    const protectedActions = plan.nodes.filter(({ id }) => id.includes("-action-"));

    expect(spec.intentSequence).toEqual(["implement", "test"]);
    expect(approvals).toHaveLength(2);
    expect(protectedActions).toHaveLength(2);
    expect(approvals.map(({ verification }) => verification.approvalForNodeId)).toEqual(
      protectedActions.map(({ id }) => id),
    );
    for (const [index, action] of protectedActions.entries()) {
      const gate = approvals[index];
      if (!gate) throw new Error("missing approval gate");
      expect(action.dependencies).toEqual([gate.id]);
      const previousAction = protectedActions[index - 1];
      if (index > 0 && !previousAction) throw new Error("missing preceding protected action");
      expect(gate.dependencies).toEqual(previousAction ? [previousAction.id] : []);
    }
  });

  test("gives review stages bounded workspace-reading tools", () => {
    const reviewPlan = decomposeTask(
      task({ intent: "review" }, "Review the backend implementation and its diff"),
    );
    const reviewStages = reviewPlan.nodes.filter(
      ({ routeRequest }) => routeRequest.taskIntent === "review",
    );

    expect(reviewStages.length).toBeGreaterThan(0);
    expect(
      reviewStages.every(({ routeRequest }) =>
        ["Read", "Glob", "Grep"].every((tool) => routeRequest.requiredTools.includes(tool)),
      ),
    ).toBe(true);
    expect(
      reviewStages.every(({ routeRequest }) => !routeRequest.requiredTools.includes("Write")),
    ).toBe(true);
  });

  test("allocates every budget dimension proportionally without exceeding task limits", () => {
    const spec = task({ qualityFloor: 0.92 });
    const plan = decomposeTask(spec);

    expect(plan.nodes.length).toBeGreaterThanOrEqual(4);
    expect(plan.nodes.reduce((sum, node) => sum + node.contextBudget, 0)).toBeLessThanOrEqual(
      spec.budget.maxInputTokens,
    );
    expect(plan.nodes.reduce((sum, node) => sum + node.outputBudget, 0)).toBeLessThanOrEqual(
      spec.budget.maxOutputTokens,
    );
    expect(
      plan.nodes.reduce((sum, node) => sum + node.outputBudget * node.maxAttempts, 0),
    ).toBeLessThanOrEqual(spec.budget.maxOutputTokens);
    expect(plan.nodes.reduce((sum, node) => sum + node.maxCostUsd, 0)).toBeCloseTo(
      spec.budget.maxCostUsd,
      8,
    );
    expect(
      plan.nodes.every(({ contextBudget, outputBudget }) => contextBudget > 0 && outputBudget > 0),
    ).toBe(true);
  });

  test("collapses a long single-intent prompt instead of emitting an impossible repeated DAG", () => {
    const prompt = `Implement the requested parser. ${"authoritative context ".repeat(5_500)}`;
    const spec = createTaskSpec(prompt, {
      id: "long-prompt",
      budget: {
        maxInputTokens: 120_000,
        maxOutputTokens: 30_000,
        maxCostUsd: 10,
        maxDurationMs: 30_000,
        maxAttempts: 3,
      },
    });
    const plan = decomposeTask(spec, { validationCommands: ["bun test"] });
    const node = plan.nodes[0];
    if (!node) throw new Error("long prompt plan is empty");

    expect(plan.nodes).toHaveLength(1);
    expect(node.expectedArtifact.type).toBe("patch");
    expect(node.routeRequest.expectedInputTokens).toBeLessThanOrEqual(node.contextBudget);
    expect(node.contextBudget).toBeLessThanOrEqual(spec.budget.maxInputTokens);
  });

  test("rejects an output budget smaller than the required number of stages", () => {
    const spec = task();
    spec.budget.maxOutputTokens = 2;
    expect(() => decomposeTask(spec)).toThrow("Output-token budget 2 cannot support");
  });

  test("inserts a human gate immediately before execution", () => {
    const critical = createTaskSpec("Deploy to production", {
      id: "critical",
      classification: classification({
        riskLevel: "critical",
        requiresHumanApproval: true,
      }),
      requiresHumanApproval: true,
    });
    const plan = decomposeTask(critical);
    const approval = plan.nodes.find(({ id }) => id.endsWith("-approval"));
    const execute = plan.nodes.find(({ id }) => id.endsWith("-execute"));
    if (!approval || !execute) throw new Error("approval fixture is incomplete");

    expect(approval.verification.requireHumanApproval).toBe(true);
    expect(approval.verification.approvalForNodeId).toBe(execute.id);
    expect(approval.maxAttempts).toBe(1);
    expect(execute.dependencies).toEqual([approval.id]);
    expect(approval.riskLevel).toBe("critical");
    expect(approval.objective).toContain("Deploy to production");
  });

  test("reports identity, reference, budget, route, and cycle defects", () => {
    const plan = decomposeTask(task());
    const malformed = structuredClone(plan.nodes);
    const first = malformed[0];
    const second = malformed[1];
    if (!first || !second) throw new Error("fixture requires two nodes");
    first.id = "";
    first.title = "";
    first.contextBudget = 0;
    first.routeRequest.stepId = "not-the-node";
    first.dependencies = [second.id, second.id];
    second.dependencies = [first.id, "missing"];

    const validation = validateDag(malformed);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("empty id");
    expect(validation.errors.join("\n")).toContain("empty title");
    expect(validation.errors.join("\n")).toContain("contextBudget");
    expect(validation.errors.join("\n")).toContain("routeRequest.stepId");
    expect(validation.errors.join("\n")).toContain("duplicate dependencies");
    expect(validation.errors.join("\n")).toContain("missing node");
  });

  test("detects cycles and refuses to topologically sort them", () => {
    const plan = decomposeTask(task());
    const cyclic = structuredClone(plan.nodes);
    const first = cyclic[0];
    const last = cyclic.at(-1);
    if (!first || !last) throw new Error("fixture requires nodes");
    first.dependencies = [last.id];

    expect(validateDag(cyclic).errors.join("\n")).toContain("dependency cycle");
    expect(() => topologicalSort(cyclic)).toThrow("Cannot sort invalid execution DAG");
  });
});
