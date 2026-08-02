import { createHash, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(value: string): number {
  let ordinaryAscii = 0;
  let structuralAscii = 0;
  let nonAsciiBytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      if (/[{}[\]();,:=<>"'`\\|&!?]/u.test(character)) structuralAscii += 1;
      else ordinaryAscii += 1;
    } else {
      nonAsciiBytes += Buffer.byteLength(character, "utf8");
    }
  }
  // ASCII prose gets a safety margin over the usual four-characters heuristic;
  // code punctuation is charged individually; multibyte scripts and emoji use
  // a conservative byte-based estimate. This remains provider-neutral while
  // avoiding the severe CJK/emoji undercount of UTF-16 length / 4.
  return Math.ceil(ordinaryAscii / 3.5) + structuralAscii + Math.ceil(nonAsciiBytes / 2);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function nowIso(): string {
  return new Date().toISOString();
}
