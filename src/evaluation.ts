import type { RiskLevel, TaskIntent } from "./contracts.ts";
import { classifyPrompt } from "./intake/index.ts";

export interface IntakeEvalCase {
  id: string;
  prompt: string;
  intent: TaskIntent;
  intentSequence?: TaskIntent[];
  risk: RiskLevel;
  approval: boolean;
  domains: string[];
}

export interface IntakeEvalFailure {
  id: string;
  mismatches: string[];
}

export interface IntakeEvalReport {
  total: number;
  passed: number;
  score: number;
  failures: IntakeEvalFailure[];
}

export function runIntakeEvals(cases: readonly IntakeEvalCase[]): IntakeEvalReport {
  const failures: IntakeEvalFailure[] = [];
  for (const evalCase of cases) {
    const result = classifyPrompt(evalCase.prompt);
    const mismatches: string[] = [];
    if (result.intent !== evalCase.intent) {
      mismatches.push(`intent expected=${evalCase.intent} actual=${result.intent}`);
    }
    if (
      evalCase.intentSequence &&
      (result.intentSequence.length !== evalCase.intentSequence.length ||
        result.intentSequence.some((intent, index) => intent !== evalCase.intentSequence?.[index]))
    ) {
      mismatches.push(
        `intentSequence expected=${evalCase.intentSequence.join(",")} actual=${result.intentSequence.join(",")}`,
      );
    }
    if (result.riskLevel !== evalCase.risk) {
      mismatches.push(`risk expected=${evalCase.risk} actual=${result.riskLevel}`);
    }
    if (result.requiresHumanApproval !== evalCase.approval) {
      mismatches.push(
        `approval expected=${evalCase.approval} actual=${result.requiresHumanApproval}`,
      );
    }
    const missingDomains = evalCase.domains.filter((domain) => !result.domains.includes(domain));
    if (missingDomains.length > 0) mismatches.push(`missing domains=${missingDomains.join(",")}`);
    if (mismatches.length > 0) failures.push({ id: evalCase.id, mismatches });
  }
  const total = cases.length;
  const passed = total - failures.length;
  return { total, passed, score: total === 0 ? 0 : passed / total, failures };
}

export function assertIntakeEvalCases(value: unknown): asserts value is IntakeEvalCase[] {
  if (!Array.isArray(value)) throw new Error("Eval dataset must be an array");
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Eval case ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.prompt !== "string" ||
      typeof record.intent !== "string" ||
      typeof record.risk !== "string" ||
      typeof record.approval !== "boolean" ||
      !Array.isArray(record.domains) ||
      record.domains.some((domain) => typeof domain !== "string") ||
      (record.intentSequence !== undefined &&
        (!Array.isArray(record.intentSequence) ||
          record.intentSequence.some((intent) => typeof intent !== "string")))
    ) {
      throw new Error(`Eval case ${index} has an invalid schema`);
    }
  }
}
