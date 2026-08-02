#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const MAX_PROMPT_CHARACTERS = 100_000;
const MODES = new Set(["plan", "dry-run", "run"]);

const [mode, separator, ...promptArguments] = process.argv.slice(2);

if (!mode || !MODES.has(mode) || separator !== "--" || promptArguments.length !== 1) {
  fail('Usage: invoke.mjs <plan|dry-run|run> -- "<objective>"');
}

const prompt = promptArguments[0]?.trim() ?? "";
if (!prompt) fail("The objective must not be empty.");
if (prompt.includes("\0")) fail("The objective must not contain NUL bytes.");
if (prompt.length > MAX_PROMPT_CHARACTERS) {
  fail(`The objective cannot exceed ${MAX_PROMPT_CHARACTERS} characters.`);
}

const args =
  mode === "plan"
    ? ["plan", "--explain", prompt]
    : mode === "dry-run"
      ? ["run", "--dry-run", "--trust-project", prompt]
      : ["run", "--trust-project", prompt];

const result = spawnSync("super-router", args, {
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  fail(
    result.error.code === "ENOENT"
      ? "The super-router executable was not found on PATH. Install @dmarigliano/super-router first."
      : `Could not start super-router: ${result.error.message}`,
  );
}

process.exitCode = result.status ?? 1;

function fail(message) {
  process.stderr.write(`super-router integration: ${message}\n`);
  process.exit(1);
}
