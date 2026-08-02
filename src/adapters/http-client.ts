import type { ExecutionContext } from "../contracts.ts";
import {
  materializationCoversRoute,
  promptContainsMaterialization,
} from "../routing/capability-materialization.ts";
import { redactText, redactValue } from "../security/redaction.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpJsonClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
}

export interface HttpJsonRequestOptions {
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
  secrets?: readonly string[];
}

export interface HttpJsonResult {
  data: unknown;
  durationMs: number;
  status: number;
}

export class HttpProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpProviderError";
    this.status = status;
  }
}

/** A bounded, non-streaming JSON transport shared by direct BYOK adapters. */
export class HttpJsonClient {
  readonly #fetch: FetchLike;
  readonly #maxResponseBytes: number;

  constructor(options: HttpJsonClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) {
      throw new Error("maxResponseBytes must be a positive integer");
    }
  }

  async postJson(
    endpoint: string,
    body: unknown,
    options: HttpJsonRequestOptions,
  ): Promise<HttpJsonResult> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("timeoutMs must be greater than zero");
    }

    const controller = new AbortController();
    let timeoutTriggered = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new Error("Provider request timed out"));
    }, options.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await readBoundedResponse(response, this.#maxResponseBytes);
      const durationMs = Date.now() - startedAt;
      const parsed = parseResponseJson(text, response.ok, options.secrets ?? []);

      if (!response.ok) {
        const detail =
          extractErrorMessage(parsed) ?? (text || response.statusText || "request failed");
        throw new HttpProviderError(
          redactKnownSecrets(
            `Provider returned HTTP ${response.status}: ${detail}`,
            options.secrets ?? [],
            2_000,
          ),
          response.status,
        );
      }
      return { data: parsed, durationMs, status: response.status };
    } catch (error) {
      if (error instanceof HttpProviderError) throw error;
      if (options.signal?.aborted) throw new HttpProviderError("Provider request was aborted");
      if (timeoutTriggered) {
        throw new HttpProviderError(`Provider request timed out after ${options.timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpProviderError(
        redactKnownSecrets(`Provider request failed: ${message}`, options.secrets ?? [], 2_000),
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function resolveApiKey(
  explicit: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  environmentVariable: string,
): string | undefined {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(environmentVariable)) {
    throw new Error("API key environment variable must be an uppercase environment name");
  }
  const candidate = explicit?.trim() || environment[environmentVariable]?.trim();
  return candidate || undefined;
}

export function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Provider base URL cannot contain credentials");
  if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS");
  return url.toString().replace(/\/$/u, "");
}

/** Direct API adapters intentionally execute text generation only. */
export function assertTextOnlyExecution(context: ExecutionContext, provider: string): void {
  const promptDelivered =
    materializationCoversRoute(context.materializedCapabilities, context.route) &&
    promptContainsMaterialization(context.prompt, context.materializedCapabilities);
  const capabilities = [
    ...context.route.tools.map((tool) => `tool:${tool}`),
    ...(promptDelivered ? [] : context.route.skills.map((skill) => `skill:${skill}`)),
    ...(context.route.agent && !promptDelivered ? [`agent:${context.route.agent}`] : []),
  ];
  if (capabilities.length > 0) {
    throw new HttpProviderError(
      `${provider} direct BYOK execution is text-only and cannot execute ${capabilities.join(", ")}`,
    );
  }
}

export function redactProviderValue(value: unknown, secrets: readonly string[]): unknown {
  return redactValue(value, { customPatterns: secretPatterns(secrets) });
}

export function redactKnownSecrets(
  value: string,
  secrets: readonly string[],
  maxStringLength?: number,
): string {
  return redactText(value, {
    customPatterns: secretPatterns(secrets),
    ...(maxStringLength === undefined ? {} : { maxStringLength }),
  });
}

function secretPatterns(secrets: readonly string[]): RegExp[] {
  return secrets
    .filter((secret) => secret.length > 0)
    .map((secret) => new RegExp(escapeRegExp(secret), "g"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new HttpProviderError(`Provider response exceeded ${limit} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("response size limit exceeded");
        throw new HttpProviderError(`Provider response exceeded ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function parseResponseJson(text: string, successful: boolean, secrets: readonly string[]): unknown {
  if (!text.trim()) {
    if (successful) throw new HttpProviderError("Provider returned an empty response");
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (!successful) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpProviderError(
      redactKnownSecrets(`Provider returned invalid JSON: ${message}`, secrets, 2_000),
    );
  }
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return typeof record.message === "string" ? record.message : undefined;
}
