import type { PlanNode, TaskSpec } from "../contracts.ts";

const protectedConcerns = [
  "trust-boundary validation",
  "security controls",
  "accessibility",
  "data-loss prevention",
  "required error handling",
  "acceptance criteria",
];

export interface SimplicityPolicyResult {
  enabled: boolean;
  level: "off" | "lite" | "full";
  directive: string;
  protectedConcerns: string[];
}

export function buildSimplicityPolicy(task: TaskSpec, node: PlanNode): SimplicityPolicyResult {
  const isImplementation = ["implement", "fix", "refactor", "optimize", "debug"].includes(
    node.routeRequest.taskIntent,
  );
  if (!isImplementation || node.expectedArtifact.type !== "patch") {
    return {
      enabled: false,
      level: "off",
      directive: "No implementation-minimization policy is needed for this step.",
      protectedConcerns,
    };
  }

  const level = task.riskLevel === "low" || task.riskLevel === "medium" ? "full" : "lite";
  const directive = [
    "Before writing code, stop at the first sufficient rung:",
    "1. Confirm the requested behavior needs to exist.",
    "2. Reuse an existing project capability when possible.",
    "3. Prefer the standard library or a native platform feature.",
    "4. Prefer an already-installed dependency over adding another.",
    "5. Otherwise implement the smallest maintainable change that satisfies every acceptance criterion.",
    `Never remove: ${protectedConcerns.join(", ")}.`,
  ].join("\n");

  return { enabled: true, level, directive, protectedConcerns };
}
