import { createHash } from "node:crypto";

const REDACTED = "[REDACTED]";

// Terminal string controls can mutate titles, hyperlinks, or clipboard state.
// Strip both terminated and unterminated OSC/DCS/APC/PM sequences before the
// shorter CSI and C0/C1 controls so no dangerous introducer reaches a TTY.
const TERMINAL_STRING_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitization intentionally matches control bytes.
  /(?:\u001B[\]P^_]|[\u0090\u009D\u009E\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)/g;
const TERMINAL_CSI_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitization intentionally matches control bytes.
  /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const TERMINAL_REMAINING_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitization intentionally matches control bytes.
  /\u001B(?:[@-_]|[^\r\n]?)|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Patterns are deliberately conservative: telemetry and memory are less useful
 * than a leaked credential is harmful.  Keep this list local so callers cannot
 * accidentally disable the built-in protections when adding custom patterns.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\bsk-ant-[a-z0-9_-]{16,}\b/gi,
  /\bsk-(?:proj-)?[a-z0-9_-]{16,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9]{20,}\b/gi,
  /\bgithub_pat_[a-z0-9_]{20,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(?:xox[aboprs]-)[a-z0-9-]{10,}\b/gi,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}\b/gi,
];

const SENSITIVE_KEY =
  /(?:api[_-]?key|apiKey|access[_-]?token|accessToken|auth(?:orization)?|client[_-]?secret|clientSecret|credential|passwd|password|private[_-]?key|privateKey|refresh[_-]?token|refreshToken|secret|session[_-]?token|sessionToken)/i;

const ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|apiKey|access[_-]?token|accessToken|authorization|client[_-]?secret|clientSecret|password|private[_-]?key|privateKey|refresh[_-]?token|refreshToken|secret|session[_-]?token|sessionToken)\b(\s*[:=]\s*)(["']?)([^\s,"'\]}]{6,}|[^"']{6,}\3)/gi;

export interface RedactionOptions {
  replacement?: string;
  customPatterns?: readonly RegExp[];
  maxStringLength?: number;
}

export function redactText(value: string, options: RedactionOptions = {}): string {
  const replacement = options.replacement ?? REDACTED;
  let redacted = value;

  for (const pattern of [...SECRET_PATTERNS, ...(options.customPatterns ?? [])]) {
    // RegExp objects retain lastIndex. Cloning makes repeated calls deterministic.
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), replacement);
  }

  redacted = redacted.replace(
    ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${replacement}`,
  );

  const limit = options.maxStringLength;
  if (limit !== undefined && limit >= 0 && redacted.length > limit) {
    return `${redacted.slice(0, limit)}...[TRUNCATED ${redacted.length - limit} chars]`;
  }
  return redacted;
}

/** Makes untrusted text inert when rendered to a terminal while preserving tabs and line breaks. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(TERMINAL_STRING_CONTROL, "")
    .replace(TERMINAL_CSI_CONTROL, "")
    .replace(TERMINAL_REMAINING_CONTROL, "");
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  return redactValueInternal(value, options, new WeakSet<object>());
}

function redactValueInternal(
  value: unknown,
  options: RedactionOptions,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, options, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, options),
      stack: value.stack ? redactText(value.stack, options) : undefined,
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? (options.replacement ?? REDACTED)
      : redactValueInternal(child, options, seen);
  }
  return result;
}

export function hashSensitiveText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function containsLikelySecret(value: string): boolean {
  if (ASSIGNMENT_PATTERN.test(value)) {
    ASSIGNMENT_PATTERN.lastIndex = 0;
    return true;
  }
  ASSIGNMENT_PATTERN.lastIndex = 0;
  return SECRET_PATTERNS.some((pattern) => {
    const candidate = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    return candidate.test(value);
  });
}
