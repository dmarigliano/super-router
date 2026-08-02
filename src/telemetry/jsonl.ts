import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashSensitiveText, redactValue } from "../security/redaction.ts";

export type TelemetryEventType =
  | "run.started"
  | "run.finished"
  | "step.started"
  | "step.attempted"
  | "step.finished"
  | "verification.finished"
  | "policy.decision"
  | "budget.exhausted"
  | "adapter.error";

export interface TelemetryEvent {
  type: TelemetryEventType;
  runId: string;
  stepId?: string;
  timestamp?: string;
  payload?: unknown;
}

export interface TelemetrySink {
  record(event: TelemetryEvent): Promise<void>;
}

export interface JsonlTelemetryOptions {
  directory: string;
  enabled?: boolean;
  includePromptHash?: boolean;
  retentionDays?: number;
  now?: () => Date;
  append?: typeof appendFile;
}

/** Append-only, redacted telemetry. Raw prompts are never persisted. */
export class JsonlTelemetry implements TelemetrySink {
  readonly #directory: string;
  readonly #enabled: boolean;
  readonly #includePromptHash: boolean;
  readonly #retentionDays: number;
  readonly #now: () => Date;
  readonly #append: typeof appendFile;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonlTelemetryOptions) {
    this.#directory = options.directory;
    this.#enabled = options.enabled ?? true;
    this.#includePromptHash = options.includePromptHash ?? true;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? (() => new Date());
    this.#append = options.append ?? appendFile;
  }

  async record(event: TelemetryEvent): Promise<void> {
    if (!this.#enabled) return;
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(async () => {
        const now = this.#now();
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const safeEvent = sanitizeTelemetryEvent(event, this.#includePromptHash);
        const record = redactValue(
          {
            schemaVersion: 1,
            type: safeEvent.type,
            runId: safeEvent.runId,
            ...(safeEvent.stepId ? { stepId: safeEvent.stepId } : {}),
            timestamp: safeEvent.timestamp ?? now.toISOString(),
            ...(safeEvent.payload === undefined ? {} : { payload: safeEvent.payload }),
          },
          { maxStringLength: 32_000 },
        );
        const path = join(this.#directory, eventFileName(now));
        await this.#append(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      });
    return await this.#writeQueue;
  }

  async prune(): Promise<number> {
    if (!this.#enabled || this.#retentionDays <= 0) return 0;
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }

    const cutoff = this.#now().getTime() - this.#retentionDays * 24 * 60 * 60 * 1_000;
    let removed = 0;
    for (const entry of entries) {
      if (!/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) continue;
      const path = join(this.#directory, entry);
      const metadata = await stat(path);
      if (metadata.mtimeMs >= cutoff) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }
}

export class NullTelemetry implements TelemetrySink {
  async record(_event: TelemetryEvent): Promise<void> {}
}

/** Removes free-form strings before an event reaches any durable or custom sink. */
export function sanitizeTelemetryEvent(
  event: TelemetryEvent,
  includePromptHash = false,
): TelemetryEvent {
  return {
    type: event.type,
    runId: safeTelemetryIdentifier(event.runId),
    ...(event.stepId ? { stepId: safeTelemetryIdentifier(event.stepId) } : {}),
    ...(event.timestamp && Number.isFinite(Date.parse(event.timestamp))
      ? { timestamp: event.timestamp }
      : {}),
    ...(event.payload === undefined
      ? {}
      : {
          payload: protectPromptFields(event.payload, includePromptHash, new WeakSet<object>()),
        }),
  };
}

function eventFileName(date: Date): string {
  return `events-${date.toISOString().slice(0, 10)}.jsonl`;
}

function protectPromptFields(value: unknown, includeHash: boolean, seen: WeakSet<object>): unknown {
  return protectTelemetryValue(value, includeHash, seen);
}

function protectTelemetryValue(
  value: unknown,
  includeHash: boolean,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (/^(?:prompt|rawPrompt|systemPrompt|input)$/iu.test(key ?? "")) {
      return includeHash ? `[OMITTED sha256:${hashSensitiveText(value)}]` : "[OMITTED]";
    }
    return isSafeTelemetryString(key, value) ? value : "[OMITTED]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.map((item) => protectTelemetryValue(item, includeHash, seen, key));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    result[childKey] = protectTelemetryValue(child, includeHash, seen, childKey);
  }
  return result;
}

function isSafeTelemetryString(key: string | undefined, value: string): boolean {
  switch (key) {
    case "state":
      return [
        "pending",
        "running",
        "simulated",
        "verified",
        "failed",
        "needs-human",
        "needs-escalation",
        "budget-exhausted",
      ].includes(value);
    case "effort":
      return ["economy", "balanced", "deep", "max"].includes(value);
    case "riskLevel":
      return ["low", "medium", "high", "critical"].includes(value);
    case "kind":
      return ["read", "local-write", "external-write", "destructive"].includes(value);
    case "source":
      return ["plan", "provider", "verification", "user"].includes(value);
    case "provider":
    case "model":
    case "agent":
    case "skills":
    case "tools":
    case "planId":
      return /^[a-zA-Z0-9][a-zA-Z0-9@._:/+-]{0,127}$/u.test(value);
    default:
      return false;
  }
}

function safeTelemetryIdentifier(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9@._:/+-]{0,127}$/u.test(value) ? value : "[OMITTED]";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
