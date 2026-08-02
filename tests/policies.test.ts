import { describe, expect, test } from "bun:test";
import type { PlanNode, TaskSpec } from "../src/contracts.ts";
import { createTaskSpec } from "../src/intake/task-spec.ts";
import { decomposeTask } from "../src/planning/decomposer.ts";
import { compactHandoff, compressToolOutput, shouldCompress } from "../src/policies/compression.ts";
import { buildSimplicityPolicy } from "../src/policies/simplicity.ts";

function executionNode(spec: TaskSpec): PlanNode {
  const node = decomposeTask(spec).nodes.find(
    ({ expectedArtifact }) => expectedArtifact.type === "patch",
  );
  if (!node) throw new Error("fixture did not produce a patch node");
  return node;
}

describe("minimum-sufficient implementation policy", () => {
  test("enables the full Ponytail-style policy for ordinary code patches", () => {
    const spec = createTaskSpec("Implement a small helper", { id: "low-risk" });
    const policy = buildSimplicityPolicy(spec, executionNode(spec));

    expect(policy.enabled).toBe(true);
    expect(policy.level).toBe("full");
    expect(policy.directive).toContain("first sufficient rung");
    expect(policy.directive).toContain("standard library");
    expect(policy.directive).toContain("already-installed dependency");
    expect(policy.protectedConcerns).toEqual(
      expect.arrayContaining([
        "security controls",
        "accessibility",
        "data-loss prevention",
        "acceptance criteria",
      ]),
    );
  });

  test("uses lite minimization for high-risk patches so controls remain explicit", () => {
    const spec = createTaskSpec("Fix the authentication vulnerability", {
      id: "high-risk",
    });
    expect(spec.riskLevel).toBe("high");
    expect(buildSimplicityPolicy(spec, executionNode(spec)).level).toBe("lite");
  });

  test("does not apply implementation minimization to analysis artifacts", () => {
    const spec = createTaskSpec("Review the backend implementation", { id: "review" });
    const node = decomposeTask(spec).nodes[0];
    if (!node) throw new Error("review fixture did not produce a node");
    const policy = buildSimplicityPolicy(spec, node);
    expect(policy).toMatchObject({ enabled: false, level: "off" });
    expect(policy.directive).toContain("No implementation-minimization policy");
  });

  test("applies implementation minimization to a later patch in an ordered multi-intent plan", () => {
    const spec = createTaskSpec("Review the backend endpoint, then fix the bug", {
      id: "review-then-fix",
    });
    const patch = executionNode(spec);

    expect(spec.intent).toBe("review");
    expect(patch.routeRequest.taskIntent).toBe("fix");
    expect(buildSimplicityPolicy(spec, patch)).toMatchObject({ enabled: true, level: "full" });
  });
});

describe("Caveman-style output compression", () => {
  test("uses a bounded output-length and capability-overhead compression heuristic", () => {
    expect(shouldCompress("short output")).toBe(false);
    expect(shouldCompress("x".repeat(1_204))).toBe(true);
    expect(shouldCompress("x".repeat(2_000), 1_000)).toBe(false);
    expect(shouldCompress("x".repeat(8_100), 1_000)).toBe(true);
  });

  test("strips ANSI noise and returns short output without semantic changes", () => {
    expect(compressToolOutput("\u001b[31mfailed\u001b[0m\n\n\nnext")).toBe("failed\n\nnext");
  });

  test("strips OSC hyperlinks without removing their visible label", () => {
    const linked = "before \u001b]8;;https://example.com\u001b\\visible\u001b]8;;\u001b\\ after";
    expect(compressToolOutput(linked)).toBe("before visible after");
  });

  test("handles an adversarially long ANSI sequence with bounded state", () => {
    const adversarial = `before\u001b[${";#".repeat(100_000)}mafter`;
    expect(compressToolOutput(adversarial)).toBe("beforeafter");
  });

  test("honors explicit hard bounds even when the default compression heuristic says no", () => {
    const compressed = compressToolOutput("0123456789abcdefghijklmnopqrstuvwxyz", {
      maxLines: 1,
      maxCharacters: 10,
      preserveTailLines: 0,
    });

    expect(compressed.length).toBeLessThanOrEqual(10);
  });

  test("rejects invalid public compression limits", () => {
    expect(() => compressToolOutput("text", { maxCharacters: 0 })).toThrow(
      "maxCharacters must be a positive integer",
    );
    expect(() => compressToolOutput("text", { maxLines: -1 })).toThrow(
      "maxLines must be a positive integer",
    );
  });

  test("keeps a bounded head and tail with an explicit omission marker", () => {
    const raw = Array.from(
      { length: 200 },
      (_, index) => `line-${String(index).padStart(3, "0")}-${"x".repeat(20)}`,
    ).join("\n");
    const compressed = compressToolOutput(raw, {
      maxLines: 30,
      maxCharacters: 10_000,
      preserveTailLines: 5,
    });

    expect(compressed).toContain("line-000");
    expect(compressed).toContain("171 lines omitted");
    expect(compressed).toContain("line-199");
    expect(compressed.split("\n")).toHaveLength(30);
  });

  test("preserves the tail when both line and character limits apply", () => {
    const raw = [
      ...Array.from({ length: 19 }, (_, index) => `line-${index}-${"x".repeat(100)}`),
      `line-19-${"x".repeat(80)}-FINAL_ERROR`,
    ].join("\n");
    const compressed = compressToolOutput(raw, {
      maxLines: 8,
      maxCharacters: 120,
      preserveTailLines: 3,
    });

    expect(compressed.length).toBeLessThanOrEqual(120);
    expect(compressed).toContain("FINAL_ERROR");
    expect(compressed).toContain("head and tail preserved");
  });

  test.each([
    "SECURITY finding: unsafe authentication",
    "WARNING: irreversible operation",
    "Human approval is required before data loss",
  ])("does not omit safety-bearing output: %s", (marker) => {
    const raw = `${marker}\n${"sensitive evidence\n".repeat(400)}`;
    const compressed = compressToolOutput(raw, { maxCharacters: 2_000, maxLines: 10 });
    expect(compressed.startsWith(marker)).toBe(true);
    expect(compressed).not.toContain("lines omitted");
    expect(compressed.length).toBeLessThanOrEqual(2_000);
    expect(compressed.split("\n").length).toBeLessThanOrEqual(10);
  });

  test("enforces the line ceiling for long safety-bearing output", () => {
    const compressed = compressToolOutput(
      Array.from({ length: 100 }, (_, index) =>
        index === 80 ? "WARNING: irreversible action" : `line ${index}`,
      ).join("\n"),
      { maxCharacters: 24_000, maxLines: 10 },
    );

    expect(compressed.split("\n").length).toBeLessThanOrEqual(10);
    expect(compressed).toContain("WARNING: irreversible action");
  });

  test("preserves a security marker that appears beyond the character cutoff", () => {
    const warning = "SECURITY: critical vulnerability at tail";
    const result = compressToolOutput(`${"x".repeat(30_000)}\n${warning}`, {
      maxCharacters: 1_000,
      maxLines: 20,
    });

    expect(result.length).toBeLessThanOrEqual(1_000);
    expect(result).toContain(warning);
    expect(result).toContain("safety-bearing excerpts preserved");
  });

  test.each([1, 2, 10, 50, 100])(
    "never exceeds a tiny safety-output budget of %i characters",
    (maxCharacters) => {
      const result = compressToolOutput(`SECURITY: finding\n${"x".repeat(10_000)}`, {
        maxCharacters,
        maxLines: 1,
      });
      expect(result.length).toBeLessThanOrEqual(maxCharacters);
    },
  );

  test("compacts handoffs deterministically and omits empty values", () => {
    expect(
      compactHandoff({
        step: "inspect",
        summary: "  found   three files  ",
        files: 3,
        verified: true,
        empty: "",
      }),
    ).toBe("step=inspect | summary=found three files | files=3 | verified=true");
  });
});
