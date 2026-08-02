import { describe, expect, test } from "bun:test";
import { AnthropicApiAdapter } from "../src/adapters/anthropic-api.ts";
import type { AbortableExecutionContext } from "../src/adapters/execution-context.ts";
import type { FetchLike } from "../src/adapters/http-client.ts";
import { OpenAIApiAdapter } from "../src/adapters/openai-api.ts";
import { defaultConfig } from "../src/config.ts";
import type { ExecutionContext, ModelCapability, RouteDecision } from "../src/contracts.ts";
import { createTaskSpec } from "../src/intake/task-spec.ts";
import { decomposeTask } from "../src/planning/decomposer.ts";
import { buildCapabilityInstructions } from "../src/prompt-builder.ts";

interface CapturedRequest {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

function model(provider: string, modelId: string): ModelCapability {
  return {
    provider,
    model: modelId,
    displayName: modelId,
    taskTypes: ["research"],
    domains: ["general"],
    supportedEfforts: ["economy", "balanced", "deep", "max"],
    tools: [],
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    cachedInputCostPerMillion: 0.3,
    qualityPrior: 0.9,
    latencyPriorMs: 1_000,
    enabled: true,
  };
}

function executionContext(provider: string, modelId: string): ExecutionContext {
  const task = createTaskSpec("Research the safest concise answer", {
    config: defaultConfig,
    intent: "research",
  });
  const plan = decomposeTask(task, { forceSingleStep: true });
  const step = plan.nodes[0];
  if (!step) throw new Error("test plan has no node");
  step.outputBudget = 256;
  step.routeRequest.requiredTools = [];
  const route: RouteDecision = {
    provider,
    model: modelId,
    effort: "balanced",
    skills: [],
    tools: [],
    expectedQuality: 0.9,
    expectedCostUsd: 0.01,
    expectedLatencyMs: 1_000,
    reason: "test route",
  };
  return {
    cwd: process.cwd(),
    runId: "run-byok-test",
    task,
    step,
    route,
    prompt: "Return a concise result.",
    timeoutMs: 1_000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Anthropic direct BYOK adapter", () => {
  test("uses the official non-streaming Messages shape and normalizes text and usage", async () => {
    const apiKey = "anthropic-test-key-1234567890";
    const captured: CapturedRequest[] = [];
    const fakeFetch: FetchLike = async (input, init) => {
      captured.push({ input, init });
      return jsonResponse({
        id: "msg_test",
        type: "message",
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "Safe answer" },
        ],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
          output_tokens: 50,
        },
      });
    };
    const pricing = model("anthropic-api", "claude-test");
    const adapter = new AnthropicApiAdapter({
      apiKey,
      environment: {},
      fetch: fakeFetch,
      models: [pricing],
    });

    expect(await adapter.isAvailable()).toBe(true);
    expect(captured).toHaveLength(0);
    const result = await adapter.execute(executionContext("anthropic-api", "claude-test"));
    expect(result.output).toBe("Safe answer");
    expect(result.artifacts).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 130,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedInputTokens: 10,
    });
    expect(result.usage.costUsd).toBeGreaterThan(0);

    const request = captured[0];
    if (!request) throw new Error("request was not captured");
    expect(String(request.input)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("x-api-key")).toBe(apiKey);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "Return a concise result." }],
      stream: false,
      output_config: { effort: "medium" },
    });
    expect("tools" in body).toBe(false);
  });
});

describe("OpenAI direct BYOK adapter", () => {
  test("uses Responses with store false and normalizes output, cache, and reasoning usage", async () => {
    const apiKey = "openai-test-key-1234567890";
    const captured: CapturedRequest[] = [];
    const fakeFetch: FetchLike = async (input, init) => {
      captured.push({ input, init });
      return jsonResponse({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Normalized answer", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 25 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 150,
        },
      });
    };
    const pricing = model("openai-api", "gpt-test");
    const adapter = new OpenAIApiAdapter({
      apiKey,
      environment: {},
      fetch: fakeFetch,
      models: [pricing],
    });

    expect(await adapter.isAvailable()).toBe(true);
    expect(captured).toHaveLength(0);
    const result = await adapter.execute(executionContext("openai-api", "gpt-test"));
    expect(result.output).toBe("Normalized answer");
    expect(result.artifacts).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 12,
      cachedInputTokens: 25,
    });
    expect(result.usage.costUsd).toBeGreaterThan(0);

    const request = captured[0];
    if (!request) throw new Error("request was not captured");
    expect(String(request.input)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(request.init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-test",
      input: "Return a concise result.",
      max_output_tokens: 256,
      store: false,
      stream: false,
      reasoning: { effort: "medium" },
    });
    expect("tools" in body).toBe(false);
  });

  test("treats a refusal block as a provider failure instead of verified text", async () => {
    const adapter = new OpenAIApiAdapter({
      apiKey: "test-key",
      environment: {},
      fetch: async () =>
        jsonResponse({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "refusal", refusal: "I cannot complete this request" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    });

    await expect(adapter.execute(executionContext("openai-api", "gpt-test"))).rejects.toThrow(
      "OpenAI refused the request",
    );
  });
});

describe("BYOK transport boundaries", () => {
  test("reports unavailable without a key and never calls fetch during availability checks", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const adapter = new OpenAIApiAdapter({ environment: {}, fetch: fakeFetch });
    expect(await adapter.isAvailable()).toBe(false);
    expect(calls).toBe(0);
    await expect(adapter.execute(executionContext("openai-api", "gpt-test"))).rejects.toThrow(
      "OPENAI_API_KEY is not configured",
    );
    expect(calls).toBe(0);
  });

  test("redacts the exact key from provider errors and successful output/raw values", async () => {
    const apiKey = "provider-specific-secret-that-must-disappear";
    const failing = new OpenAIApiAdapter({
      apiKey,
      environment: {},
      fetch: async () => jsonResponse({ error: { message: `invalid ${apiKey}` } }, 401),
    });
    let errorMessage = "";
    try {
      await failing.execute(executionContext("openai-api", "gpt-test"));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("[REDACTED]");
    expect(errorMessage).not.toContain(apiKey);

    const successful = new OpenAIApiAdapter({
      apiKey,
      environment: {},
      fetch: async () =>
        jsonResponse({
          status: "completed",
          output_text: `accidental echo ${apiKey}`,
          usage: {},
        }),
    });
    const result = await successful.execute(executionContext("openai-api", "gpt-test"));
    expect(result.output).toContain("[REDACTED]");
    expect(JSON.stringify(result.raw)).not.toContain(apiKey);
  });

  test("rejects oversized responses before parsing", async () => {
    const adapter = new AnthropicApiAdapter({
      apiKey: "test-key",
      environment: {},
      maxResponseBytes: 32,
      fetch: async () => jsonResponse({ content: [{ type: "text", text: "x".repeat(100) }] }),
    });
    await expect(adapter.execute(executionContext("anthropic-api", "claude-test"))).rejects.toThrow(
      "exceeded 32 bytes",
    );
  });

  test("propagates an execution abort through the fetch signal", async () => {
    let receivedAbortedSignal = false;
    const fakeFetch: FetchLike = async (_input, init) => {
      receivedAbortedSignal = init?.signal?.aborted ?? false;
      throw new DOMException("aborted", "AbortError");
    };
    const adapter = new OpenAIApiAdapter({
      apiKey: "test-key",
      environment: {},
      fetch: fakeFetch,
    });
    const controller = new AbortController();
    controller.abort();
    const context: AbortableExecutionContext = {
      ...executionContext("openai-api", "gpt-test"),
      signal: controller.signal,
    };
    await expect(adapter.execute(context)).rejects.toThrow("request was aborted");
    expect(receivedAbortedSignal).toBe(true);
  });

  test("refuses to claim agent, skill, or tool execution", async () => {
    let calls = 0;
    const adapter = new AnthropicApiAdapter({
      apiKey: "test-key",
      environment: {},
      fetch: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    const context = executionContext("anthropic-api", "claude-test");
    context.route.tools = ["Read"];
    context.route.skills = ["research-skill"];
    context.route.agent = "researcher";
    await expect(adapter.execute(context)).rejects.toThrow("text-only");
    expect(calls).toBe(0);
  });

  test("accepts prompt-materialized capabilities when no provider tools are claimed", async () => {
    let calls = 0;
    const adapter = new AnthropicApiAdapter({
      apiKey: "test-key",
      environment: {},
      fetch: async () => {
        calls += 1;
        return jsonResponse({
          type: "message",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: {},
        });
      },
    });
    const context = executionContext("anthropic-api", "claude-test");
    context.route.agent = "researcher";
    context.route.skills = ["research-skill"];
    context.materializedCapabilities = {
      delivery: "prompt",
      agent: { id: "researcher", instructions: "Use a concise research method." },
      skills: [{ id: "research-skill", instructions: "Check primary evidence." }],
    };
    context.prompt = buildCapabilityInstructions(context.materializedCapabilities);

    await expect(adapter.execute(context)).resolves.toMatchObject({ output: "done" });
    expect(calls).toBe(1);
  });
});
