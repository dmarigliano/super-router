const MAX_BUFFERED_ANSI_SEQUENCE = 4_096;

type AnsiState =
  | "text"
  | "escape"
  | "escape-intermediate"
  | "csi"
  | "csi-discard"
  | "osc"
  | "osc-escape"
  | "osc-discard"
  | "osc-discard-escape";

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isCsiBody(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Removes terminal control sequences in one pass. Potentially malformed
 * sequences retain at most a small fixed buffer; longer sequences are
 * discarded until their terminator instead of triggering unbounded lookahead.
 */
function stripAnsiSequences(value: string): string {
  const output: string[] = [];
  let pending: string[] = [];
  let state: AnsiState = "text";

  const reset = (): void => {
    pending = [];
    state = "text";
  };
  const preserveMalformed = (): void => {
    output.push(...pending);
    reset();
  };
  const buffer = (character: string): boolean => {
    pending.push(character);
    return pending.length <= MAX_BUFFERED_ANSI_SEQUENCE;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = value.charCodeAt(index);

    switch (state) {
      case "text":
        if (code === 0x1b) {
          pending = [character];
          state = "escape";
        } else if (code === 0x9b) {
          pending = [character];
          state = "csi";
        } else {
          output.push(character);
        }
        break;
      case "escape":
        buffer(character);
        if (character === "[") {
          state = "csi";
        } else if (character === "]") {
          state = "osc";
        } else if (isEscapeIntermediate(code)) {
          state = "escape-intermediate";
        } else if (isEscapeFinal(code)) {
          reset();
        } else {
          preserveMalformed();
        }
        break;
      case "escape-intermediate":
        if (!buffer(character)) {
          preserveMalformed();
        } else if (isEscapeIntermediate(code)) {
          break;
        } else if (isEscapeFinal(code)) {
          reset();
        } else {
          preserveMalformed();
        }
        break;
      case "csi":
        if (!buffer(character)) {
          pending = [];
          state = "csi-discard";
        } else if (isCsiFinal(code)) {
          reset();
        } else if (!isCsiBody(code)) {
          preserveMalformed();
        }
        break;
      case "csi-discard":
        if (isCsiFinal(code)) state = "text";
        else if (!isCsiBody(code)) state = "text";
        break;
      case "osc":
        if (!buffer(character)) {
          pending = [];
          state = code === 0x1b ? "osc-discard-escape" : "osc-discard";
        } else if (code === 0x07 || code === 0x9c) {
          reset();
        } else if (code === 0x1b) {
          state = "osc-escape";
        }
        break;
      case "osc-escape":
        if (!buffer(character)) {
          pending = [];
          state = character === "\\" ? "text" : "osc-discard";
        } else if (character === "\\" || code === 0x07 || code === 0x9c) {
          reset();
        } else {
          state = code === 0x1b ? "osc-escape" : "osc";
        }
        break;
      case "osc-discard":
        if (code === 0x07 || code === 0x9c) state = "text";
        else if (code === 0x1b) state = "osc-discard-escape";
        break;
      case "osc-discard-escape":
        if (character === "\\" || code === 0x07 || code === 0x9c) state = "text";
        else state = code === 0x1b ? "osc-discard-escape" : "osc-discard";
        break;
    }
  }

  if (pending.length > 0) output.push(...pending);
  return output.join("");
}

const safetyMarkers = [
  "security",
  "warning",
  "irreversible",
  "destructive",
  "permission",
  "credential",
  "data loss",
  "approval",
];

export interface CompressionOptions {
  maxLines: number;
  maxCharacters: number;
  preserveTailLines: number;
}

const defaults: CompressionOptions = {
  maxLines: 120,
  maxCharacters: 24_000,
  preserveTailLines: 20,
};

export function shouldCompress(text: string, overheadTokens = 0): boolean {
  const estimatedTokens = Math.ceil(text.length / 4);
  return estimatedTokens > Math.max(300, overheadTokens * 2);
}

export function compressToolOutput(raw: string, options: Partial<CompressionOptions> = {}): string {
  const config = { ...defaults, ...options };
  if (!Number.isInteger(config.maxLines) || config.maxLines < 1) {
    throw new Error("maxLines must be a positive integer");
  }
  if (!Number.isInteger(config.maxCharacters) || config.maxCharacters < 1) {
    throw new Error("maxCharacters must be a positive integer");
  }
  if (!Number.isInteger(config.preserveTailLines) || config.preserveTailLines < 0) {
    throw new Error("preserveTailLines must be a non-negative integer");
  }
  const cleaned = stripAnsiSequences(raw)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = cleaned.split("\n");
  if (
    !shouldCompress(cleaned) &&
    lines.length <= config.maxLines &&
    cleaned.length <= config.maxCharacters
  ) {
    return cleaned;
  }

  const lowercase = cleaned.toLowerCase();
  if (safetyMarkers.some((marker) => lowercase.includes(marker))) {
    const maximum = Math.max(1, config.maxCharacters);
    if (cleaned.length <= maximum && lines.length <= config.maxLines) return cleaned;
    const excerpts = safetyMarkers.flatMap((marker) => {
      const matches: Array<{ index: number; text: string }> = [];
      let offset = 0;
      while (matches.length < 8) {
        const index = lowercase.indexOf(marker, offset);
        if (index < 0) break;
        const lineStart = cleaned.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
        const excerptStart = index - lineStart <= 160 ? lineStart : index;
        matches.push({
          index,
          text: cleaned
            .slice(excerptStart, Math.min(cleaned.length, index + 800))
            .replace(/\s+/gu, " ")
            .trim(),
        });
        offset = index + marker.length;
      }
      return matches;
    });
    const uniqueExcerpts = [
      ...new Set(excerpts.sort((left, right) => left.index - right.index).map(({ text }) => text)),
    ];
    const excerptSlots = Math.max(1, config.maxLines - 1);
    const selected = uniqueExcerpts.slice(0, excerptSlots);
    if (config.maxLines > selected.length) {
      selected.push("… safety-bearing excerpts preserved from bounded output …");
    }
    return selected.slice(0, config.maxLines).join("\n").slice(0, maximum);
  }

  if (lines.length <= config.maxLines && cleaned.length <= config.maxCharacters) return cleaned;

  const contentSlots = Math.max(0, config.maxLines - 1);
  const tailCount = Math.min(config.preserveTailLines, Math.floor(contentSlots / 3));
  const headCount = contentSlots - tailCount;
  const omitted = Math.max(0, lines.length - headCount - tailCount);
  const selected = [
    ...lines.slice(0, headCount),
    `… ${omitted} lines omitted; raw output retained in the run artifact …`,
    ...lines.slice(-tailCount),
  ];
  const rendered = selected.join("\n");
  const maximum = Math.max(1, config.maxCharacters);
  if (rendered.length <= maximum) return rendered;

  const omission = `\n… ${omitted} lines omitted; bounded head and tail preserved …\n`;
  if (maximum <= omission.length) return rendered.slice(-maximum);
  const remaining = maximum - omission.length;
  const headCharacters = Math.floor(remaining / 2);
  const tailCharacters = remaining - headCharacters;
  const head = lines.slice(0, headCount).join("\n").slice(0, headCharacters);
  const tail = lines.slice(-tailCount).join("\n");
  return `${head}${omission}${tailCharacters > 0 ? tail.slice(-tailCharacters) : ""}`;
}

export function compactHandoff(fields: Record<string, string | number | boolean>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ").trim()}`)
    .join(" | ");
}
