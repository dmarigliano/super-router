// biome-ignore lint/complexity/useRegexLiterals: the escaped constructor avoids literal control characters.
const ansiPattern = new RegExp(
  "[\\u001B\\u009B][[\\]\\()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

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
  const cleaned = raw
    .replace(ansiPattern, "")
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
