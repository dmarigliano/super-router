import { describe, expect, test } from "bun:test";
import type { PlanNode } from "../src/contracts.ts";
import { OperationalPolicy } from "../src/security/policy.ts";

function approvalNode(requireHumanApproval: boolean): PlanNode {
  return {
    id: "approve-production",
    title: "Approve production deployment",
    objective: "Deploy the payment webhook to production after reviewing rollback impact",
    dependencies: [],
    expectedArtifact: {
      type: "review",
      description: "Exact approval record",
      paths: ["deploy/payment-webhook.json"],
    },
    riskLevel: "critical",
    qualityFloor: 0.95,
    routeRequest: {
      stepId: "approve-production",
      taskIntent: "review",
      domains: ["payments"],
      riskLevel: "critical",
      qualityFloor: 0.95,
      expectedInputTokens: 100,
      expectedOutputTokens: 100,
      requiredTools: [],
    },
    contextRefs: [],
    contextBudget: 1_000,
    outputBudget: 500,
    maxCostUsd: 1,
    maxAttempts: 1,
    verification: {
      commands: [],
      requireIndependentReview: false,
      requireHumanApproval,
      minimumScore: 0.95,
    },
  };
}

describe("exact human approval ownership", () => {
  test("never treats a critical local action as an ordinary unapproved write", async () => {
    const policy = new OperationalPolicy();
    const decision = await policy.authorize({
      kind: "local-write",
      description: "Change critical access policy",
      riskLevel: "critical",
      source: "plan",
    });
    const satisfied = await policy.authorize({
      kind: "local-write",
      description: "Change critical access policy",
      riskLevel: "critical",
      source: "plan",
      approvalSatisfied: true,
    });

    expect(decision).toMatchObject({ allowed: false, requiresApproval: true });
    expect(satisfied).toMatchObject({ allowed: true, requiresApproval: true });
  });

  test("defers an explicit approval node to verification without prompting twice", async () => {
    let prompts = 0;
    const policy = new OperationalPolicy({
      allowExternalWrites: true,
      approvalHandler: async () => {
        prompts += 1;
        return true;
      },
    });
    const action = policy.inspectNode(approvalNode(true));
    const decision = await policy.authorize(action);

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain("deferred to verification");
    expect(prompts).toBe(0);
    expect(action.description).toContain("Deploy the payment webhook to production");
    expect(action.target).toBe("deploy/payment-webhook.json");
  });

  test("still prompts once for an external node without an explicit approval verifier", async () => {
    let prompts = 0;
    const policy = new OperationalPolicy({
      allowExternalWrites: true,
      approvalHandler: async () => {
        prompts += 1;
        return true;
      },
    });

    const node = approvalNode(false);
    node.routeRequest.requiredTools = ["Deploy"];
    const decision = await policy.authorize(policy.inspectNode(node));

    expect(decision.allowed).toBe(true);
    expect(prompts).toBe(1);
  });

  test("treats an observational node that discusses a future deployment as read-only", () => {
    const node = approvalNode(false);
    node.riskLevel = "low";
    node.routeRequest.riskLevel = "low";

    expect(new OperationalPolicy().inspectNode(node).kind).toBe("read");
  });
});
