import { constants as fsConstants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecord } from "./contracts.ts";

export interface TelemetryStats {
  files: number;
  filesDiscovered: number;
  filesSkipped: number;
  bytesRead: number;
  recordsExamined: number;
  truncated: boolean;
  events: number;
  malformedLines: number;
  runsStarted: number;
  runsFinished: number;
  stepsFinished: number;
  verifiedRuns: number;
  failedRuns: number;
  usage: UsageRecord;
  /**
   * Pre-run reservations summed over the steps that recorded one, and the
   * provider-reported usage of those same steps. The pair is what makes the
   * estimator's error measurable: the estimate covers Super Router's own prompt,
   * while the provider also charges for its system prompt, ambient instructions,
   * files read during the turn, and context resent on later turns.
   */
  reserved: ReservedUsageTotals;
  stepUsage: ReservedUsageTotals;
}

export interface ReservedUsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TelemetryStatsLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxRecords?: number;
}

export const DEFAULT_TELEMETRY_STATS_MAX_FILES = 400;
export const DEFAULT_TELEMETRY_STATS_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TELEMETRY_STATS_MAX_RECORDS = 1_000_000;

const MAX_TELEMETRY_FILE_BYTES = 64 * 1024 * 1024;
const HARD_TELEMETRY_STATS_MAX_FILES = 10_000;
const HARD_TELEMETRY_STATS_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const HARD_TELEMETRY_STATS_MAX_RECORDS = 10_000_000;

const EMPTY_USAGE: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
  durationMs: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Only counts a step when it recorded both a reservation and reported usage, so
 * the two totals stay comparable. A step whose provider returned no usage would
 * otherwise drag the ratio toward zero and understate the error.
 */
function accumulateReservation(result: TelemetryStats, payload: unknown): void {
  if (!isRecord(payload) || !isRecord(payload.reservedUsage)) return;
  const usage = usageFromPayload(payload);
  if (!usage) return;
  const reserved = payload.reservedUsage;
  result.reserved.inputTokens += finite(reserved.inputTokens);
  result.reserved.outputTokens += finite(reserved.outputTokens);
  result.reserved.costUsd += finite(reserved.costUsd);
  result.stepUsage.inputTokens += usage.inputTokens;
  result.stepUsage.outputTokens += usage.outputTokens;
  result.stepUsage.costUsd += usage.costUsd;
}

function usageFromPayload(value: unknown): UsageRecord | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.usage)
    ? value.usage
    : isRecord(value.result) && isRecord(value.result.usage)
      ? value.result.usage
      : undefined;
  if (!candidate) return undefined;
  return {
    inputTokens: finite(candidate.inputTokens),
    outputTokens: finite(candidate.outputTokens),
    reasoningTokens: finite(candidate.reasoningTokens),
    cachedInputTokens: finite(candidate.cachedInputTokens),
    costUsd: finite(candidate.costUsd),
    durationMs: finite(candidate.durationMs),
    ...(candidate.estimated === true ? { estimated: true } : {}),
  };
}

function addUsage(target: UsageRecord, source: UsageRecord): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.costUsd += source.costUsd;
  target.durationMs += source.durationMs;
  if (source.estimated === true) target.estimated = true;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return selected;
}

type TelemetryFileRead =
  | { status: "ok"; contents: string; bytes: number }
  | { status: "per-file-limit" | "global-limit" | "unsafe" };

async function readBoundedTelemetryFile(
  path: string,
  maxFileBytes: number,
  remainingBytes: number,
): Promise<TelemetryFileRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { status: "unsafe" };
    if (metadata.size > maxFileBytes) return { status: "per-file-limit" };
    if (metadata.size > remainingBytes) return { status: "global-limit" };

    const buffer = Buffer.alloc(metadata.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (
      bytesRead !== metadata.size ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs
    ) {
      return { status: "unsafe" };
    }
    return { status: "ok", contents: buffer.toString("utf8"), bytes: bytesRead };
  } catch {
    return { status: "unsafe" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function processTelemetryContents(
  contents: string,
  result: TelemetryStats,
  maxRecords: number,
): boolean {
  let cursor = 0;
  while (cursor < contents.length) {
    const newline = contents.indexOf("\n", cursor);
    const end = newline < 0 ? contents.length : newline;
    const line = contents.slice(cursor, end).replace(/\r$/u, "");
    cursor = newline < 0 ? contents.length : newline + 1;
    if (!line.trim()) continue;
    if (result.recordsExamined >= maxRecords) return true;
    result.recordsExamined += 1;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error("event is not an object");
      event = parsed;
    } catch {
      result.malformedLines += 1;
      continue;
    }
    result.events += 1;
    if (event.type === "run.started") result.runsStarted += 1;
    if (event.type === "step.finished") {
      result.stepsFinished += 1;
      accumulateReservation(result, event.payload);
    }
    if (event.type !== "run.finished") continue;
    result.runsFinished += 1;
    const payload = isRecord(event.payload) ? event.payload : {};
    const state =
      typeof payload.state === "string"
        ? payload.state
        : isRecord(payload.result) && typeof payload.result.state === "string"
          ? payload.result.state
          : "";
    if (state === "verified") result.verifiedRuns += 1;
    else result.failedRuns += 1;
    const usage = usageFromPayload(payload);
    if (usage) addUsage(result.usage, usage);
  }
  return false;
}

export async function readTelemetryStats(
  directory: string,
  maxFileBytes = MAX_TELEMETRY_FILE_BYTES,
  limits: TelemetryStatsLimits = {},
): Promise<TelemetryStats> {
  const boundedFileBytes = boundedLimit(
    maxFileBytes,
    MAX_TELEMETRY_FILE_BYTES,
    MAX_TELEMETRY_FILE_BYTES,
    "maxFileBytes",
  );
  const maxFiles = boundedLimit(
    limits.maxFiles,
    DEFAULT_TELEMETRY_STATS_MAX_FILES,
    HARD_TELEMETRY_STATS_MAX_FILES,
    "maxFiles",
  );
  const maxTotalBytes = boundedLimit(
    limits.maxTotalBytes,
    DEFAULT_TELEMETRY_STATS_MAX_TOTAL_BYTES,
    HARD_TELEMETRY_STATS_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxRecords = boundedLimit(
    limits.maxRecords,
    DEFAULT_TELEMETRY_STATS_MAX_RECORDS,
    HARD_TELEMETRY_STATS_MAX_RECORDS,
    "maxRecords",
  );
  const result: TelemetryStats = {
    files: 0,
    filesDiscovered: 0,
    filesSkipped: 0,
    bytesRead: 0,
    recordsExamined: 0,
    truncated: false,
    events: 0,
    malformedLines: 0,
    runsStarted: 0,
    runsFinished: 0,
    stepsFinished: 0,
    verifiedRuns: 0,
    failedRuns: 0,
    usage: { ...EMPTY_USAGE },
    reserved: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    stepUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
      .sort()
      .reverse();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return result;
    throw error;
  }

  result.filesDiscovered = files.length;
  const selectedFiles = files.slice(0, maxFiles);
  if (selectedFiles.length < files.length) {
    result.filesSkipped += files.length - selectedFiles.length;
    result.truncated = true;
  }

  for (const [index, file] of selectedFiles.entries()) {
    if (result.recordsExamined >= maxRecords || result.bytesRead >= maxTotalBytes) {
      result.filesSkipped += selectedFiles.length - index;
      result.truncated = true;
      break;
    }
    const path = join(directory, file);
    const read = await readBoundedTelemetryFile(
      path,
      boundedFileBytes,
      maxTotalBytes - result.bytesRead,
    );
    if (read.status !== "ok") {
      result.filesSkipped += 1;
      result.truncated = true;
      if (read.status !== "global-limit") result.malformedLines += 1;
      continue;
    }
    result.files += 1;
    result.bytesRead += read.bytes;
    if (processTelemetryContents(read.contents, result, maxRecords)) {
      result.filesSkipped += selectedFiles.length - index - 1;
      result.truncated = true;
      break;
    }
  }
  return result;
}

/** Renders one axis as `40.0x under` / `10.0x over` / `on target`. */
function accuracyRatio(reserved: number, actual: number): string {
  if (reserved <= 0 || actual <= 0) return "unknown";
  const ratio = actual / reserved;
  if (ratio >= 1.05) return `${ratio.toFixed(1)}x under`;
  if (ratio <= 0.95) return `${(1 / ratio).toFixed(1)}x over`;
  return "on target";
}

export function renderTelemetryStats(stats: TelemetryStats): string {
  const acceptance = stats.runsFinished > 0 ? (stats.verifiedRuns / stats.runsFinished) * 100 : 0;
  const costPerAccepted = stats.verifiedRuns > 0 ? stats.usage.costUsd / stats.verifiedRuns : 0;
  const hasReservations = stats.reserved.inputTokens > 0 || stats.reserved.outputTokens > 0;
  const accuracy = hasReservations
    ? [
        `Estimate accuracy vs provider: input=${accuracyRatio(
          stats.reserved.inputTokens,
          stats.stepUsage.inputTokens,
        )} output=${accuracyRatio(stats.reserved.outputTokens, stats.stepUsage.outputTokens)}`,
        `  reserved input=${stats.reserved.inputTokens} output=${stats.reserved.outputTokens} | reported input=${stats.stepUsage.inputTokens} output=${stats.stepUsage.outputTokens}`,
      ]
    : [];
  return [
    "Super Router local telemetry",
    `Runs: started=${stats.runsStarted} finished=${stats.runsFinished} verified=${stats.verifiedRuns} failed=${stats.failedRuns}`,
    `Acceptance rate: ${acceptance.toFixed(1)}%`,
    `Steps finished: ${stats.stepsFinished}`,
    `Tokens: input=${stats.usage.inputTokens} output=${stats.usage.outputTokens} reasoning=${stats.usage.reasoningTokens} cached=${stats.usage.cachedInputTokens}`,
    `Cost: $${stats.usage.costUsd.toFixed(4)} | cost/accepted: $${costPerAccepted.toFixed(4)}`,
    ...accuracy,
    `Telemetry: files=${stats.files}/${stats.filesDiscovered} skipped=${stats.filesSkipped} bytes=${stats.bytesRead} records=${stats.recordsExamined} events=${stats.events} malformed=${stats.malformedLines} truncated=${stats.truncated}`,
  ].join("\n");
}
