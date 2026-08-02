import type { CapabilitySnapshot, ExecutionPlan, RunResult, UsageRecord } from "./contracts.ts";
import { compressToolOutput } from "./policies/compression.ts";
import { redactText, sanitizeTerminalText } from "./security/redaction.ts";

const money = (value: number): string => `$${value.toFixed(4)}`;

export function renderPlan(plan: ExecutionPlan): string {
  const lines = [
    `Super Router plan ${plan.id}`,
    `Objective: ${plan.task.objective}`,
    `Intent: ${plan.task.intent} | Risk: ${plan.task.riskLevel} | Quality floor: ${plan.task.qualityFloor.toFixed(2)}`,
    `Predicted primary-call cost: ${money(plan.predictedPrimaryCallCostUsd)} | Steps: ${plan.nodes.length}`,
    "",
  ];

  for (const node of plan.nodes) {
    const route = node.route;
    lines.push(`${node.id}. ${node.title}`);
    lines.push(`   depends: ${node.dependencies.length ? node.dependencies.join(", ") : "none"}`);
    lines.push(
      route
        ? `   route: ${route.provider}/${route.model} effort=${route.effort} quality=${route.expectedQuality.toFixed(2)} cost=${money(route.expectedCostUsd)}`
        : "   route: unresolved",
    );
    if (route?.agent) lines.push(`   agent: ${route.agent}`);
    if (route?.skills.length) lines.push(`   skills: ${route.skills.join(", ")}`);
    lines.push(`   verify: ${node.verification.commands.join(", ") || "policy checks"}`);
  }

  if (plan.explanation.length) {
    lines.push("", "Decisions:", ...plan.explanation.map((reason) => `- ${reason}`));
  }
  return lines.join("\n");
}

function addUsage(target: UsageRecord, source: UsageRecord): UsageRecord {
  return {
    inputTokens: target.inputTokens + source.inputTokens,
    outputTokens: target.outputTokens + source.outputTokens,
    reasoningTokens: target.reasoningTokens + source.reasoningTokens,
    cachedInputTokens: target.cachedInputTokens + source.cachedInputTokens,
    costUsd: target.costUsd + source.costUsd,
    durationMs: target.durationMs + source.durationMs,
    ...(target.estimated === true || source.estimated === true ? { estimated: true } : {}),
  };
}

export function summarizeUsage(run: Pick<RunResult, "steps">): UsageRecord {
  return run.steps.reduce((total, step) => addUsage(total, step.usage), {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    durationMs: 0,
  });
}

export function renderRunResult(run: RunResult): string {
  const simulationSuffix = run.simulated && run.state !== "simulated" ? " (simulation)" : "";
  const lines = [
    `Super Router run ${run.runId}: ${run.state}${simulationSuffix}`,
    run.summary,
    "",
    "Steps:",
  ];

  for (const step of run.steps) {
    lines.push(
      `- ${step.stepId}: ${step.state} attempt=${step.attempt} route=${step.route.provider}/${step.route.model} cost=${money(step.usage.costUsd)}`,
    );
    if (step.verification) {
      lines.push(
        `  verification=${step.verification.passed ? "passed" : "failed"} score=${step.verification.score.toFixed(2)}`,
      );
    }
    if (step.error) lines.push(`  error=${step.error}`);
    for (const check of step.verification?.checks.filter(({ passed }) => !passed) ?? []) {
      lines.push(`  failed-check=${check.name}: ${check.details.slice(0, 1_000)}`);
    }
  }

  if (run.acceptance) {
    lines.push(
      "",
      `Task acceptance: ${run.acceptance.passed ? "passed" : "failed"} score=${run.acceptance.score.toFixed(2)}`,
    );
    for (const check of run.acceptance.checks.filter(({ passed }) => !passed)) {
      lines.push(`- ${check.name}: ${check.details.slice(0, 1_000)}`);
    }
  }

  const nodeById = new Map(run.plan.nodes.map((node) => [node.id, node]));
  const renderedResults = run.steps
    .filter((step) => {
      const node = nodeById.get(step.stepId);
      return (
        step.output.trim().length > 0 &&
        node !== undefined &&
        !node.verification.requireHumanApproval &&
        node.expectedArtifact.type !== "test-report"
      );
    })
    .slice(-6);
  if (renderedResults.length > 0) {
    lines.push("", "Delivered results:");
    for (const step of renderedResults) {
      const node = nodeById.get(step.stepId);
      if (!node) continue;
      lines.push(
        `- ${node.title} [${node.expectedArtifact.type}]`,
        redactText(
          compressToolOutput(step.output, {
            maxLines: 60,
            maxCharacters: 4_000,
            preserveTailLines: 12,
          }),
          { maxStringLength: 4_000 },
        ),
      );
      if (step.artifacts.length > 0) lines.push(`  artifacts: ${step.artifacts.join(", ")}`);
    }
  }

  lines.push(
    "",
    `Usage${run.usage.estimated ? " (conservative estimate)" : ""}: input=${run.usage.inputTokens} output=${run.usage.outputTokens} reasoning=${run.usage.reasoningTokens} cached=${run.usage.cachedInputTokens}`,
    `Cost: ${money(run.usage.costUsd)} | Duration: ${(run.usage.durationMs / 1000).toFixed(2)}s`,
  );
  return sanitizeTerminalText(lines.join("\n"));
}

export function renderCapabilities(snapshot: CapabilitySnapshot): string {
  const lines = [
    `Capabilities discovered at ${snapshot.discoveredAt}`,
    `Models (${snapshot.models.length}):`,
    ...snapshot.models.map(
      (model) =>
        `- ${model.provider}/${model.model}: enabled=${model.enabled} quality=${model.qualityPrior.toFixed(2)} efforts=${model.supportedEfforts.join(",")}`,
    ),
    `Agents (${snapshot.agents.length}):`,
    ...snapshot.agents.map((agent) => `- ${agent.id}: ${agent.description}`),
    `Skills (${snapshot.skills.length}):`,
    ...snapshot.skills.map(
      (skill) => `- ${skill.id}: trusted=${skill.trusted} enabled=${skill.enabled}`,
    ),
  ];
  return lines.join("\n");
}
