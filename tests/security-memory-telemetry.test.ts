import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessInvocation, ProcessRunner } from "../src/adapters/process-runner.ts";
import type { PlanNode, StepResult } from "../src/contracts.ts";
import { DEFAULT_MEMORY_DOCUMENT_MAX_BYTES, LocalMemoryStore } from "../src/memory/local-memory.ts";
import {
  minimalVerificationEnvironment,
  SafeVerificationRunner,
} from "../src/runtime/verification.ts";
import { sanitizeTerminalText } from "../src/security/redaction.ts";
import { JsonlTelemetry } from "../src/telemetry/jsonl.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("verification containment and environment", () => {
  test("rejects an artifact symlink whose canonical target escapes the workspace", async () => {
    const workspace = await temporaryDirectory("super-router-workspace-");
    const outside = await temporaryDirectory("super-router-outside-");
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, join(workspace, "escaped-artifact"));

    const node = planNode({ paths: ["escaped-artifact"] });
    const result = await new SafeVerificationRunner().verify({
      cwd: workspace,
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "artifact:escaped-artifact",
        passed: false,
        details: expect.stringContaining("symlink resolves outside"),
      }),
    );
  });

  test("allows a symlink only when its canonical target remains in the workspace", async () => {
    const workspace = await temporaryDirectory("super-router-workspace-");
    await writeFile(join(workspace, "real-artifact"), "inside", "utf8");
    await symlink("real-artifact", join(workspace, "contained-artifact"));
    const node = planNode({ paths: ["contained-artifact"] });
    const result = await new SafeVerificationRunner().verify({
      cwd: workspace,
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ details: expect.stringContaining("Contained symlink") }),
    );
  });

  test("runs allowlisted verification with a replacement environment that omits secrets", async () => {
    let invocation: ProcessInvocation | undefined;
    const runner: ProcessRunner = {
      run: async (received) => {
        invocation = received;
        return {
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
        };
      },
    };
    const environment = minimalVerificationEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      OPENAI_API_KEY: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    });
    const node = planNode({ commands: ["probe --safe"] });
    const result = await new SafeVerificationRunner({
      runner,
      allowlist: ["probe"],
      environment,
    }).verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(true);
    expect(invocation?.envMode).toBe("replace");
    expect(invocation?.env).toMatchObject({ PATH: "/safe/bin", HOME: "/safe/home", CI: "1" });
    expect(invocation?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(invocation?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  test("rejects a prose-only test report without objective evidence", async () => {
    const node = planNode({ artifactType: "test-report" });
    const result = await new SafeVerificationRunner().verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "test-report-evidence", passed: false }),
    );
  });

  test("accepts a test report backed by a successful deterministic command", async () => {
    const runner: ProcessRunner = {
      run: async () => ({
        stdout: "all tests passed",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        timedOut: false,
      }),
    };
    const node = planNode({ artifactType: "test-report", commands: ["probe --tests"] });
    const result = await new SafeVerificationRunner({
      runner,
      allowlist: ["probe"],
    }).verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "probe --tests", passed: true }),
    );
  });

  test("accepts a test report backed by a contained artifact", async () => {
    const workspace = await temporaryDirectory("super-router-test-report-");
    await writeFile(join(workspace, "report.json"), '{"passed":true}', "utf8");
    const node = planNode({ artifactType: "test-report" });
    const result = await new SafeVerificationRunner().verify({
      cwd: workspace,
      runId: "run",
      node,
      step: stepResult(node, ["report.json"]),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "artifact:report.json", passed: true }),
    );
  });

  test("fails closed when an independent reviewer exceeds the remaining budget", async () => {
    const node = planNode();
    node.verification.requireIndependentReview = true;
    const result = await new SafeVerificationRunner({
      independentReviewer: async () =>
        await new Promise(() => {
          // Deliberately ignores cancellation to prove a late callback cannot verify the step.
        }),
    }).verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 15,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "independent-review",
        passed: false,
        details: expect.stringContaining("timed out"),
      }),
    );
  });

  test("propagates abort to human approval and never treats it as consent", async () => {
    const node = planNode();
    node.verification.requireHumanApproval = true;
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    let called = false;
    const result = await new SafeVerificationRunner({
      humanApproval: async () => {
        called = true;
        return true;
      },
    }).verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node),
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    expect(called).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "human-approval", passed: false }),
    );
  });

  test.each([
    ["FAIL — a critical vulnerability remains\nSUPER_ROUTER_VERDICT: FAIL", false],
    ["Looks fine but has no structured verdict", false],
    ["No required correction remains\nSUPER_ROUTER_VERDICT: PASS", true],
  ] as const)("enforces a fail-closed semantic review verdict", async (output, passed) => {
    const node = planNode();
    node.verification.reviewVerdictRequired = true;
    const result = await new SafeVerificationRunner().verify({
      cwd: process.cwd(),
      runId: "run",
      node,
      step: stepResult(node, [], output),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(passed);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "semantic-review-verdict", passed }),
    );
  });
});

describe("local memory integrity", () => {
  test("does not recover unrelated memory from verification and recency bonuses alone", async () => {
    const directory = await temporaryDirectory("super-router-memory-relevance-");
    const store = new LocalMemoryStore({
      directory,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    await store.remember({
      title: "Database migration",
      summary: "Postgres schema rollout procedure",
      content: "Apply the schema changes in a transaction.",
      tags: ["database"],
      provenance: {
        projectId: "project",
        source: "test",
        capturedAt: "2026-08-01T12:00:00.000Z",
        verified: true,
        confidence: 1,
      },
    });

    const hits = await store.search("authentication sessions", {
      projectId: "project",
      verifiedOnly: true,
    });

    expect(hits).toEqual([]);
  });

  test("redacts secrets, keeps provenance, and detects content tampering", async () => {
    const directory = await temporaryDirectory("super-router-memory-");
    const store = new LocalMemoryStore({ directory });
    const entry = await store.remember({
      title: "Verified decision",
      summary: "Authentication decision",
      content: "apiKey=abcdefghijklmnop and use server sessions",
      tags: ["auth"],
      provenance: {
        projectId: "project",
        source: "test",
        capturedAt: "2026-08-01T00:00:00.000Z",
        commit: "abc123",
        verified: true,
        confidence: 1,
      },
    });
    const [document] = await store.get([entry.id], "project");
    expect(document?.content).not.toContain("abcdefghijklmnop");
    expect(document?.provenance.commit).toBe("abc123");

    const documentPath = join(directory, "documents", `${entry.id}.json`);
    const tampered = JSON.parse(await readFile(documentPath, "utf8")) as Record<string, unknown>;
    tampered.content = "tampered";
    await writeFile(documentPath, JSON.stringify(tampered), "utf8");
    await expect(store.get([entry.id], "project")).rejects.toThrow("integrity check failed");
  });

  test("rejects symbolic-link and oversized memory documents before parsing", async () => {
    const directory = await temporaryDirectory("super-router-memory-doc-bounds-");
    const store = new LocalMemoryStore({ directory });
    const entry = await store.remember(memoryObservation("bounded document"));
    const documentPath = join(directory, "documents", `${entry.id}.json`);
    const outsidePath = join(directory, "outside.json");
    await writeFile(outsidePath, JSON.stringify({ content: "outside" }), "utf8");

    const strictReader = new LocalMemoryStore({ directory, maxContentLength: 4 });
    await expect(strictReader.get([entry.id], "project")).rejects.toThrow(
      "Memory content exceeds 4 characters",
    );

    await rm(documentPath);
    await symlink(outsidePath, documentPath);
    await expect(store.get([entry.id], "project")).rejects.toThrow("must not be a symbolic link");

    await rm(documentPath);
    await writeFile(documentPath, "x".repeat(DEFAULT_MEMORY_DOCUMENT_MAX_BYTES + 1), "utf8");
    await expect(store.get([entry.id], "project")).rejects.toThrow("Memory document exceeds");
  });

  test("reads only the newest complete index records within the byte budget", async () => {
    const directory = await temporaryDirectory("super-router-memory-bytes-");
    let clock = 0;
    const writer = new LocalMemoryStore({
      directory,
      now: () => new Date(Date.UTC(2026, 7, 1, 0, 0, clock++)),
    });
    await writer.remember(memoryObservation("oldest"));
    await writer.remember(memoryObservation("middle"));
    await writer.remember(memoryObservation("newest"));

    const persisted = await readFile(join(directory, "index.jsonl"), "utf8");
    const lines = persisted.trimEnd().split("\n");
    const newestLine = lines.at(-1);
    if (!newestLine) throw new Error("memory index was not written");

    const reader = new LocalMemoryStore({
      directory,
      maxIndexBytes: Buffer.byteLength(`${newestLine}\n`),
    });
    const hits = await reader.search("", { projectId: "project", limit: 100 });

    expect(hits.map((hit) => hit.title)).toEqual(["newest"]);
  });

  test("bounds parsed index records and prefers the most recent tail", async () => {
    const directory = await temporaryDirectory("super-router-memory-records-");
    let clock = 0;
    const writer = new LocalMemoryStore({
      directory,
      now: () => new Date(Date.UTC(2026, 7, 1, 0, 0, clock++)),
    });
    await writer.remember(memoryObservation("oldest"));
    await writer.remember(memoryObservation("middle"));
    await writer.remember(memoryObservation("newest"));

    const reader = new LocalMemoryStore({ directory, maxIndexRecords: 2 });
    const hits = await reader.search("", { projectId: "project", limit: 100 });

    expect(hits.map((hit) => hit.title)).toEqual(["newest", "middle"]);
  });

  test("skips an index record whose tags schema was tampered", async () => {
    const directory = await temporaryDirectory("super-router-memory-schema-");
    const store = new LocalMemoryStore({ directory });
    const valid = await store.remember(memoryObservation("valid"));
    await appendFile(
      join(directory, "index.jsonl"),
      `${JSON.stringify({ ...valid, id: "11111111-1111-4111-8111-111111111111", tags: [1] })}\n`,
      "utf8",
    );

    const hits = await store.search("", { projectId: "project", limit: 100 });

    expect(hits.map((hit) => hit.title)).toEqual(["valid"]);
  });

  test("fails safely when the bounded tail contains no complete index record", async () => {
    const directory = await temporaryDirectory("super-router-memory-oversized-line-");
    await writeFile(join(directory, "index.jsonl"), `${"x".repeat(8_192)}\n`, "utf8");
    const reader = new LocalMemoryStore({ directory, maxIndexBytes: 1_024 });

    await expect(reader.search("anything", { projectId: "project" })).resolves.toEqual([]);
  });

  test("rejects unsafe index limits at construction", async () => {
    const directory = await temporaryDirectory("super-router-memory-limits-");

    expect(() => new LocalMemoryStore({ directory, maxIndexBytes: 0 })).toThrow(
      "maxIndexBytes must be a positive integer",
    );
    expect(
      () => new LocalMemoryStore({ directory, maxIndexRecords: Number.MAX_SAFE_INTEGER }),
    ).toThrow("maxIndexRecords must be a positive integer");
  });
});

describe("telemetry privacy", () => {
  test("omits nested raw prompts, redacts credentials, and tolerates circular payloads", async () => {
    const directory = await temporaryDirectory("super-router-telemetry-");
    const telemetry = new JsonlTelemetry({ directory });
    const payload: Record<string, unknown> = {
      prompt: { messages: [{ content: "private prompt" }] },
      apiKey: "sk-proj-abcdefghijklmnop",
      description: "CANARY_RAW_OBJECTIVE must never persist",
      error: "provider echoed CANARY_RAW_OBJECTIVE",
      verification: {
        checks: [{ details: "verifier echoed CANARY_RAW_OBJECTIVE" }],
      },
    };
    payload.self = payload;
    await telemetry.record({ type: "run.started", runId: "run", payload });
    const [file] = await readdir(directory);
    if (!file) throw new Error("telemetry file was not created");
    const persisted = await readFile(join(directory, file), "utf8");

    expect(persisted).not.toContain("private prompt");
    expect(persisted).not.toContain("CANARY_RAW_OBJECTIVE");
    expect(persisted).not.toContain("sk-proj-abcdefghijklmnop");
    expect(persisted).toContain("[OMITTED]");
    expect(persisted).toContain("[CIRCULAR]");
    expect(persisted).toContain("[REDACTED]");
  });
});

describe("terminal output safety", () => {
  test("removes CSI, OSC clipboard, C1, and unterminated terminal controls", () => {
    const malicious = [
      "visible",
      "\u001b[31mred\u001b[0m",
      "\u001b]52;c;Y2xpcGJvYXJk\u0007after",
      "\u009b2Jclear",
      "tail\u001b]8;;https://evil.invalid",
    ].join("\n");
    const safe = sanitizeTerminalText(malicious);

    expect(safe).toContain("visible");
    expect(safe).toContain("red");
    expect(safe).toContain("after");
    expect(safe).toContain("clear");
    expect(safe).not.toContain("Y2xpcGJvYXJk");
    expect(safe).not.toContain("evil.invalid");
    expect(safe).not.toContain("\u001b");
    expect(safe).not.toContain("\u009b");
  });
});

function memoryObservation(title: string) {
  return {
    title,
    summary: `${title} summary`,
    content: `${title} content`,
    tags: ["bounded"],
    provenance: {
      projectId: "project",
      source: "test",
      capturedAt: "2026-08-01T00:00:00.000Z",
      verified: true,
      confidence: 1,
    },
  };
}

function planNode(
  options: {
    paths?: string[];
    commands?: string[];
    artifactType?: PlanNode["expectedArtifact"]["type"];
  } = {},
): PlanNode {
  const route = {
    provider: "test",
    model: "test",
    effort: "balanced" as const,
    skills: [],
    tools: [],
    expectedQuality: 1,
    expectedCostUsd: 0,
    expectedLatencyMs: 0,
    reason: "test",
  };
  return {
    id: "step",
    title: "Verify",
    objective: "verify",
    dependencies: [],
    expectedArtifact: {
      type: options.artifactType ?? "result",
      description: "result",
      ...(options.paths ? { paths: options.paths } : {}),
    },
    riskLevel: "low",
    qualityFloor: 0.8,
    routeRequest: {
      stepId: "step",
      taskIntent: "test",
      domains: ["general"],
      riskLevel: "low",
      qualityFloor: 0.8,
      expectedInputTokens: 1,
      expectedOutputTokens: 1,
      requiredTools: [],
    },
    route,
    contextRefs: [],
    contextBudget: 1,
    outputBudget: 1,
    maxCostUsd: 1,
    maxAttempts: 1,
    verification: {
      commands: options.commands ?? [],
      requireIndependentReview: false,
      requireHumanApproval: false,
      minimumScore: 0.8,
    },
  };
}

function stepResult(
  node: PlanNode,
  artifacts: string[] = [],
  output = "provider output",
): StepResult {
  if (!node.route) throw new Error("test fixture route is missing");
  return {
    stepId: node.id,
    state: "running",
    attempt: 1,
    route: node.route,
    output,
    artifacts,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
    },
  };
}
