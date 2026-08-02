import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { ProcessInvocation, ProcessRunner } from "../src/adapters/process-runner.ts";
import { ProcessExecutionError, SpawnProcessRunner } from "../src/adapters/process-runner.ts";
import { ProviderExecutionError } from "../src/adapters/shared.ts";
import type { ExecutionContext, ModelCapability } from "../src/contracts.ts";
import { buildCapabilityInstructions } from "../src/prompt-builder.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "super-router-adapter-test-"));
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

describe("spawn process isolation", () => {
  test("replace mode does not leak inherited environment variables", async () => {
    const runner = new SpawnProcessRunner({
      baseEnv: { PATH: process.env.PATH, SUPER_ROUTER_SECRET: "must-not-leak" },
    });
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      cwd: process.cwd(),
      envMode: "replace",
      env: { SAFE_VALUE: "visible" },
      timeoutMs: 2_000,
    });
    const environment = JSON.parse(result.stdout) as Record<string, string>;
    expect(environment.SAFE_VALUE).toBe("visible");
    expect(environment.SUPER_ROUTER_SECRET).toBeUndefined();
  });

  test("timeout terminates Unix descendants in the dedicated process group", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const marker = join(directory, "descendant-survived.txt");
    const grandchild = [
      'const { writeFileSync } = require("node:fs");',
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived"), 400);`,
    ].join("");
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const runner = new SpawnProcessRunner({ killGraceMs: 25 });

    let failure: unknown;
    try {
      await runner.run({
        executable: process.execPath,
        args: ["-e", parent],
        cwd: directory,
        timeoutMs: 100,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessExecutionError);
    const processFailure = failure as ProcessExecutionError;
    expect(processFailure.result.timedOut).toBe(true);
    expect(processFailure.result.stdout).toMatch(/^\d+$/);
    await Bun.sleep(450);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Claude Code safety arguments", () => {
  test("uses ephemeral bounded sessions and prompt-only capability delivery", async () => {
    let invocation: ProcessInvocation | undefined;
    const runner: ProcessRunner = {
      run: async (received) => {
        invocation = received;
        return {
          stdout: JSON.stringify({ result: "done", usage: {} }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
        };
      },
    };
    const context = executionContext();
    context.route.skills = ["test-skill"];
    context.materializedCapabilities = {
      delivery: "prompt",
      skills: [{ id: "test-skill", instructions: "Apply the selected skill checklist." }],
    };
    context.prompt = buildCapabilityInstructions(context.materializedCapabilities);
    await new ClaudeCodeAdapter({ runner }).execute(context);

    expect(invocation?.args).toContain("--no-session-persistence");
    expect(invocation?.envMode).toBe("replace");
    expect(invocation?.args).toContain("--max-budget-usd");
    expect(invocation?.args).toContain("--max-turns");
    expect(invocation?.args).toContain("--permission-mode");
    expect(invocation?.args).toContain("--strict-mcp-config");
    expect(invocation?.args).toContain("--no-chrome");
    const tools = invocation?.args.indexOf("--tools") ?? -1;
    expect(tools).toBeGreaterThanOrEqual(0);
    expect(invocation?.args[tools + 1]).toBe("Read");
    const allowedTools = invocation?.args.indexOf("--allowedTools") ?? -1;
    expect(allowedTools).toBeGreaterThanOrEqual(0);
    expect(invocation?.args.slice(allowedTools + 1)).not.toContain("Skill");
    expect(invocation?.args).not.toContain("Bash");
    expect(invocation?.args).toContain("--safe-mode");
  });

  test("rejects selected capabilities without prompt materialization", async () => {
    const captured = capturingRunner(JSON.stringify({ result: "done", usage: {} }));
    const context = executionContext();
    context.route.skills = ["test-skill"];
    await expect(
      new ClaudeCodeAdapter({ runner: captured.runner }).execute(context),
    ).rejects.toThrow("requires selected capabilities to be materialized");
    expect(captured.invocations).toHaveLength(0);
  });

  test("disables customizations when the route selected no agent or skill", async () => {
    const captured = capturingRunner(JSON.stringify({ result: "done", usage: {} }));
    const context = executionContext();
    context.route.skills = [];
    context.route.tools = ["Read"];

    await new ClaudeCodeAdapter({ runner: captured.runner }).execute(context);

    const args = captured.invocations[0]?.args ?? [];
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
  });

  test("uses prompt materialization without native agent or skill resolution", async () => {
    const captured = capturingRunner(JSON.stringify({ result: "done", usage: {} }));
    const context = executionContext();
    context.route.agent = "test-agent";
    context.route.skills = ["test-skill"];
    context.route.tools = ["Read"];
    context.materializedCapabilities = {
      delivery: "prompt",
      agent: { id: "test-agent", instructions: "Apply the selected agent procedure." },
      skills: [{ id: "test-skill", instructions: "Apply the selected skill checklist." }],
    };
    context.prompt = buildCapabilityInstructions(context.materializedCapabilities);

    await new ClaudeCodeAdapter({ runner: captured.runner }).execute(context);

    const args = captured.invocations[0]?.args ?? [];
    expect(args).not.toContain("--agent");
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args).not.toContain("Agent");
    expect(args).not.toContain("Skill");
  });
});

describe("Codex safety arguments", () => {
  test("rejects selected capabilities without prompt materialization", async () => {
    const captured = capturingRunner(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    );
    const context = executionContext("codex", "gpt-test");
    context.route.agent = "reviewer";

    await expect(new CodexAdapter({ runner: captured.runner }).execute(context)).rejects.toThrow(
      "requires selected capabilities to be materialized",
    );
    expect(captured.invocations).toHaveLength(0);
  });

  test("derives the explicit sandbox from routed write tools", async () => {
    const readOnly = capturingRunner(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
    );
    const readContext = executionContext("codex", "gpt-test");
    readContext.task.intent = "implement";
    readContext.route.tools = ["Read", "Glob", "Grep"];
    await new CodexAdapter({ runner: readOnly.runner }).execute(readContext);
    const readInvocation = readOnly.invocations[0];

    expect(readInvocation?.args).toContain("--ignore-user-config");
    expect(readInvocation?.args).toContain("--ignore-rules");
    expect(readInvocation?.args).toContain("--ephemeral");
    const readSandboxIndex = readInvocation?.args.indexOf("--sandbox") ?? -1;
    expect(readSandboxIndex).toBeGreaterThanOrEqual(0);
    expect(readInvocation?.args[readSandboxIndex + 1]).toBe("read-only");

    const writable = capturingRunner(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
    );
    const writeContext = executionContext("codex", "gpt-test");
    writeContext.task.intent = "review";
    writeContext.route.tools = ["Read", "Write"];
    await new CodexAdapter({ runner: writable.runner }).execute(writeContext);
    const writeInvocation = writable.invocations[0];
    const writeSandboxIndex = writeInvocation?.args.indexOf("--sandbox") ?? -1;
    expect(writeSandboxIndex).toBeGreaterThanOrEqual(0);
    expect(writeInvocation?.args[writeSandboxIndex + 1]).toBe("workspace-write");
    expect(writeInvocation?.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(writeInvocation?.args).not.toContain("--dangerously-bypass-hook-trust");
  });
});

describe("provider CLI authentication probes", () => {
  test("distinguishes an installed Claude runtime from an authenticated session", async () => {
    const captured = sequenceRunner([
      { stdout: "2.1.220", exitCode: 0 },
      { stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 },
    ]);
    const adapter = new ClaudeCodeAdapter({
      runner: captured.runner,
      meteredBilling: false,
      environment: { PATH: "/safe/bin", CLAUDE_CONFIG_DIR: "/safe/claude" },
    });

    expect(await adapter.checkAvailability()).toEqual({
      installed: true,
      authenticated: false,
      available: false,
    });
    expect(captured.invocations.map(({ args }) => args)).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(captured.invocations.every(({ timeoutMs }) => timeoutMs === 3_000)).toBe(true);
    expect(captured.invocations.every(({ maxOutputBytes }) => maxOutputBytes === 64 * 1024)).toBe(
      true,
    );
    expect(captured.invocations.every(({ envMode }) => envMode === "replace")).toBe(true);
  });

  test("distinguishes an installed Codex runtime from an authenticated session", async () => {
    const captured = sequenceRunner([
      { stdout: "codex-cli 0.146.0", exitCode: 0 },
      { stderr: "Not logged in", exitCode: 1 },
    ]);
    const adapter = new CodexAdapter({
      runner: captured.runner,
      meteredBilling: false,
      environment: { PATH: "/safe/bin", CODEX_HOME: "/safe/codex" },
    });

    expect(await adapter.checkAvailability()).toEqual({
      installed: true,
      authenticated: false,
      available: false,
    });
    expect(captured.invocations.map(({ args }) => args)).toEqual([
      ["--version"],
      ["login", "status"],
    ]);
    expect(captured.invocations.every(({ timeoutMs }) => timeoutMs === 3_000)).toBe(true);
    expect(captured.invocations.every(({ maxOutputBytes }) => maxOutputBytes === 64 * 1024)).toBe(
      true,
    );
    expect(captured.invocations.every(({ envMode }) => envMode === "replace")).toBe(true);
  });
});

describe("provider CLI environment isolation", () => {
  test("allows only runtime, provider config, and billing-mode authentication", async () => {
    const source = {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/safe/cert.pem",
      NODE_EXTRA_CA_CERTS: "/safe/extra-cert.pem",
      CLAUDE_CONFIG_DIR: "/safe/claude",
      CLAUDE_CODE_GIT_BASH_PATH: "/safe/git-bash",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-subscription-token",
      ANTHROPIC_API_KEY: "anthropic-metered-key",
      CODEX_HOME: "/safe/codex",
      OPENAI_API_KEY: "openai-metered-key",
      CODEX_API_KEY: "codex-metered-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "github-secret",
      NPM_TOKEN: "npm-secret",
      SSH_AUTH_SOCK: "/sensitive/agent.sock",
      GOOGLE_APPLICATION_CREDENTIALS: "/sensitive/google.json",
      NODE_OPTIONS: "--require /sensitive/preload.js",
    };

    const claudeSubscription = capturingRunner(JSON.stringify({ result: "done", usage: {} }));
    const claudeSubscriptionAdapter = new ClaudeCodeAdapter({
      runner: claudeSubscription.runner,
      environment: source,
      meteredBilling: false,
    });
    expect(await claudeSubscriptionAdapter.isAvailable()).toBe(true);
    await claudeSubscriptionAdapter.execute(executionContext());
    assertIsolatedInvocations(
      claudeSubscription.invocations,
      {
        CLAUDE_CONFIG_DIR: "/safe/claude",
        CLAUDE_CODE_GIT_BASH_PATH: "/safe/git-bash",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-subscription-token",
        CLAUDE_CODE_ENTRYPOINT: "super-router",
      },
      3,
    );

    const claudeMetered = capturingRunner(JSON.stringify({ result: "done", usage: {} }));
    const claudeMeteredAdapter = new ClaudeCodeAdapter({
      runner: claudeMetered.runner,
      environment: source,
      meteredBilling: true,
    });
    expect(await claudeMeteredAdapter.isAvailable()).toBe(true);
    await claudeMeteredAdapter.execute(executionContext());
    assertIsolatedInvocations(claudeMetered.invocations, {
      CLAUDE_CONFIG_DIR: "/safe/claude",
      CLAUDE_CODE_GIT_BASH_PATH: "/safe/git-bash",
      ANTHROPIC_API_KEY: "anthropic-metered-key",
      CLAUDE_CODE_ENTRYPOINT: "super-router",
    });

    const codexOutput = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    });
    const codexSubscription = capturingRunner(codexOutput);
    const codexSubscriptionAdapter = new CodexAdapter({
      runner: codexSubscription.runner,
      environment: source,
      meteredBilling: false,
    });
    expect(await codexSubscriptionAdapter.isAvailable()).toBe(true);
    await codexSubscriptionAdapter.execute(executionContext("codex", "gpt-test"));
    assertIsolatedInvocations(
      codexSubscription.invocations,
      {
        CODEX_HOME: "/safe/codex",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "super-router",
      },
      3,
    );

    const codexMetered = capturingRunner(codexOutput);
    const codexMeteredAdapter = new CodexAdapter({
      runner: codexMetered.runner,
      environment: source,
      meteredBilling: true,
    });
    expect(await codexMeteredAdapter.isAvailable()).toBe(true);
    await codexMeteredAdapter.execute(executionContext("codex", "gpt-test"));
    assertIsolatedInvocations(codexMetered.invocations, {
      CODEX_HOME: "/safe/codex",
      OPENAI_API_KEY: "openai-metered-key",
      CODEX_API_KEY: "codex-metered-key",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "super-router",
    });
  });
});

describe("subscription billing accounting", () => {
  test("Claude Code preserves authoritative zero cost for success and provider errors", async () => {
    const successRunner = fixedRunner({
      stdout: JSON.stringify({
        result: "done",
        total_cost_usd: 0.75,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });
    const context = executionContext("claude-code", "sonnet");
    const adapter = new ClaudeCodeAdapter({
      runner: successRunner,
      models: [pricedModel("claude-code", "sonnet")],
      meteredBilling: false,
    });

    const result = await adapter.execute(context);
    expect(result.usage).toMatchObject({ costUsd: 0, costFinal: true });

    const failingAdapter = new ClaudeCodeAdapter({
      runner: fixedRunner({
        stdout: JSON.stringify({
          is_error: true,
          result: "provider failed",
          total_cost_usd: 0.5,
          usage: { input_tokens: 30, output_tokens: 10 },
        }),
      }),
      models: [pricedModel("claude-code", "sonnet")],
      meteredBilling: false,
    });
    let failure: unknown;
    try {
      await failingAdapter.execute(context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect((failure as ProviderExecutionError).usage).toMatchObject({
      costUsd: 0,
      costFinal: true,
    });
  });

  test("Codex preserves authoritative zero cost for success and provider errors", async () => {
    const events = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.75 },
      }),
    ].join("\n");
    const context = executionContext("codex", "gpt-test");
    const adapter = new CodexAdapter({
      runner: fixedRunner({ stdout: events }),
      models: [pricedModel("codex", "gpt-test")],
      meteredBilling: false,
    });

    const result = await adapter.execute(context);
    expect(result.usage).toMatchObject({ costUsd: 0, costFinal: true });

    const failingAdapter = new CodexAdapter({
      runner: fixedRunner({ stdout: events, stderr: "provider failed", exitCode: 1 }),
      models: [pricedModel("codex", "gpt-test")],
      meteredBilling: false,
    });
    let failure: unknown;
    try {
      await failingAdapter.execute(context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect((failure as ProviderExecutionError).usage).toMatchObject({
      costUsd: 0,
      costFinal: true,
    });
  });

  test("subscription process failures keep cost final even without provider usage", async () => {
    for (const adapter of [
      new ClaudeCodeAdapter({
        runner: fixedRunner({ exitCode: 1, stderr: "transport failed" }),
        meteredBilling: false,
      }),
      new CodexAdapter({
        runner: fixedRunner({ exitCode: 1, stderr: "transport failed" }),
        meteredBilling: false,
      }),
    ]) {
      const context = executionContext(adapter.id, adapter.id === "codex" ? "gpt-test" : "sonnet");
      let failure: unknown;
      try {
        await adapter.execute(context);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderExecutionError);
      expect((failure as ProviderExecutionError).usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costFinal: true,
      });
    }
  });
});

function fixedRunner(overrides: Partial<Awaited<ReturnType<ProcessRunner["run"]>>>): ProcessRunner {
  return {
    run: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      ...overrides,
    }),
  };
}

function sequenceRunner(results: Array<Partial<Awaited<ReturnType<ProcessRunner["run"]>>>>): {
  runner: ProcessRunner;
  invocations: ProcessInvocation[];
} {
  const invocations: ProcessInvocation[] = [];
  return {
    invocations,
    runner: {
      run: async (invocation) => {
        invocations.push(invocation);
        const result = results.shift() ?? {};
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
          ...result,
        };
      },
    },
  };
}

function capturingRunner(executionStdout: string): {
  runner: ProcessRunner;
  invocations: ProcessInvocation[];
} {
  const invocations: ProcessInvocation[] = [];
  return {
    invocations,
    runner: {
      run: async (invocation) => {
        invocations.push(invocation);
        const isClaudeAuth = invocation.args.join("\0") === "auth\0status\0--json";
        const isCodexAuth = invocation.args.join("\0") === "login\0status";
        return {
          stdout: invocation.args.includes("--version")
            ? "provider 1.0"
            : isClaudeAuth
              ? JSON.stringify({ loggedIn: true })
              : isCodexAuth
                ? "Authenticated"
                : executionStdout,
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
        };
      },
    },
  };
}

function assertIsolatedInvocations(
  invocations: readonly ProcessInvocation[],
  providerValues: Readonly<Record<string, string>>,
  expectedCount = 2,
): void {
  expect(invocations).toHaveLength(expectedCount);
  for (const [index, invocation] of invocations.entries()) {
    const authenticationKeys = new Set([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ]);
    const expectedProviderValues = Object.fromEntries(
      Object.entries(providerValues).filter(([key]) => index !== 0 || !authenticationKeys.has(key)),
    );
    expect(invocation.envMode).toBe("replace");
    expect(invocation.env).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/safe/cert.pem",
      NODE_EXTRA_CA_CERTS: "/safe/extra-cert.pem",
      ...expectedProviderValues,
    });
    for (const forbidden of [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "SSH_AUTH_SOCK",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NODE_OPTIONS",
    ]) {
      expect(invocation.env?.[forbidden]).toBeUndefined();
    }
    const providerSpecificKeys = [
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_GIT_BASH_PATH",
      "CODEX_HOME",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ];
    for (const key of providerSpecificKeys) {
      const isAuthentication = authenticationKeys.has(key);
      if (!(key in providerValues) || (index === 0 && isAuthentication)) {
        expect(invocation.env?.[key]).toBeUndefined();
      }
    }
  }
}

function pricedModel(provider: string, model: string): ModelCapability {
  return {
    provider,
    model,
    displayName: model,
    taskTypes: ["test"],
    domains: ["general"],
    supportedEfforts: ["balanced"],
    tools: ["Read", "Skill"],
    contextWindow: 100_000,
    maxOutputTokens: 10_000,
    inputCostPerMillion: 10,
    outputCostPerMillion: 30,
    qualityPrior: 0.9,
    latencyPriorMs: 1,
    enabled: true,
  };
}

function executionContext(provider = "claude-code", model = "sonnet"): ExecutionContext {
  const budget = {
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxCostUsd: 1,
    maxDurationMs: 10_000,
    maxAttempts: 2,
  };
  const route = {
    provider,
    model,
    effort: "balanced" as const,
    skills: [],
    tools: ["Read", "Bash"],
    expectedQuality: 0.9,
    expectedCostUsd: 0.01,
    expectedLatencyMs: 1,
    reason: "test",
  };
  const task = {
    id: "task",
    objective: "test",
    intent: "test" as const,
    domains: ["general"],
    languages: ["typescript"],
    riskLevel: "low" as const,
    ambiguity: 0,
    qualityFloor: 0.8,
    constraints: [],
    deliverables: [],
    acceptanceCriteria: [],
    budget,
    privacy: "ephemeral" as const,
    requiresHumanApproval: false,
  };
  const step = {
    id: "step",
    title: "Test",
    objective: "test",
    dependencies: [],
    expectedArtifact: { type: "result" as const, description: "result" },
    riskLevel: "low" as const,
    qualityFloor: 0.8,
    routeRequest: {
      stepId: "step",
      taskIntent: "test" as const,
      domains: ["general"],
      riskLevel: "low" as const,
      qualityFloor: 0.8,
      expectedInputTokens: 100,
      expectedOutputTokens: 100,
      requiredTools: ["Read"],
    },
    route,
    contextRefs: [],
    contextBudget: 100,
    outputBudget: 100,
    maxCostUsd: 0.5,
    maxAttempts: 2,
    verification: {
      commands: [],
      requireIndependentReview: false,
      requireHumanApproval: false,
      minimumScore: 0.8,
    },
  };
  return {
    cwd: process.cwd(),
    runId: "run",
    task,
    step,
    route,
    prompt: "test",
    timeoutMs: 1_000,
  };
}
