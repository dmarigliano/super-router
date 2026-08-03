import type { EffortLevel } from "./contracts.ts";

export type CliCommand =
  | "plan"
  | "run"
  | "doctor"
  | "capabilities"
  | "stats"
  | "integrations"
  | "help"
  | "version";

export interface CliOptions {
  command: CliCommand;
  prompt: string;
  cwd: string;
  configPath?: string;
  dryRun: boolean;
  explain: boolean;
  json: boolean;
  allowExternalWrites: boolean;
  allowDestructiveActions: boolean;
  trustProject: boolean;
  memoryEnabled: boolean;
  preferredProvider?: string;
  provider?: string;
  model?: string;
  effort?: EffortLevel;
  agent?: string;
  skills: string[];
  qualityFloor?: number;
  maxCostUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxDurationMs?: number;
}

const commands = new Set<CliCommand>([
  "plan",
  "run",
  "doctor",
  "capabilities",
  "stats",
  "integrations",
  "help",
  "version",
]);

const efforts = new Set<EffortLevel>(["economy", "balanced", "deep", "max"]);

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be greater than zero`);
  return value;
}

export function parseCliOptions(argv: string[], cwd = process.cwd()): CliOptions {
  const promptParts: string[] = [];
  const first = argv[0];
  const command = first && commands.has(first as CliCommand) ? (first as CliCommand) : "run";
  let index = command === "run" && first !== "run" ? 0 : 1;

  const options: CliOptions = {
    command,
    prompt: "",
    cwd,
    dryRun: command === "plan",
    explain: command === "plan",
    json: false,
    allowExternalWrites: false,
    allowDestructiveActions: false,
    trustProject: false,
    memoryEnabled: true,
    skills: [],
  };

  // `integrations` is routed by bin/super-router.js, which resolves the packaged
  // installer script relative to itself. Its flags belong to that installer, so
  // they must not reach the router option parser below.
  if (command === "integrations") return options;

  while (index < argv.length) {
    const argument = argv[index];
    if (!argument) break;
    if (!argument.startsWith("--")) {
      promptParts.push(argument);
      index += 1;
      continue;
    }

    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--explain":
        options.explain = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--allow-external-writes":
        options.allowExternalWrites = true;
        break;
      case "--allow-destructive":
        options.allowDestructiveActions = true;
        break;
      case "--trust-project":
        options.trustProject = true;
        break;
      case "--no-memory":
        options.memoryEnabled = false;
        break;
      case "--cwd":
        options.cwd = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--config":
        options.configPath = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--provider":
        options.provider = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--prefer-provider":
        options.preferredProvider = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--model":
        options.model = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--agent":
        options.agent = nextValue(argv, index, argument);
        index += 1;
        break;
      case "--skill":
        options.skills.push(nextValue(argv, index, argument));
        index += 1;
        break;
      case "--effort": {
        const effort = nextValue(argv, index, argument) as EffortLevel;
        if (!efforts.has(effort)) {
          throw new Error("--effort must be economy, balanced, deep, or max");
        }
        options.effort = effort;
        index += 1;
        break;
      }
      case "--quality-floor":
        options.qualityFloor = positiveNumber(nextValue(argv, index, argument), argument);
        if (options.qualityFloor > 1) throw new Error("--quality-floor cannot exceed 1");
        index += 1;
        break;
      case "--max-cost":
        options.maxCostUsd = positiveNumber(nextValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--max-input-tokens":
        options.maxInputTokens = positiveNumber(nextValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--max-output-tokens":
        options.maxOutputTokens = positiveNumber(nextValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--max-duration-ms":
        options.maxDurationMs = positiveNumber(nextValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--help":
        options.command = "help";
        break;
      case "--version":
        options.command = "version";
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
    index += 1;
  }

  options.prompt = promptParts.join(" ").trim();
  if (["plan", "run"].includes(options.command) && !options.prompt) {
    throw new Error(`${options.command} requires a task prompt`);
  }
  return options;
}

export const helpText = `Super Router 0.8

Usage:
  super-router plan [options] "task"    Build and explain a route without executing it
  super-router run [options] "task"     Plan, execute, verify, and report
  super-router "task"                   Alias for run
  super-router capabilities             List discovered models, agents, and skills
  super-router doctor                   Validate configuration and provider runtimes
  super-router stats                    Summarize local, redacted telemetry
  super-router integrations <action>    Install or uninstall native Codex/Claude skills
                                        (executable only; from source use
                                        node scripts/install-integrations.mjs)

Routing options:
  --prefer-provider <id>   Prefer a provider while retaining cross-provider fallback
  --provider <id>          Require a provider and disable cross-provider fallback
  --model <id>             Override the model
  --effort <level>         economy | balanced | deep | max
  --agent <id>             Override the agent
  --skill <id>             Add a skill; may be repeated
  --quality-floor <0..1>   Minimum predicted and verified quality

Budget and safety:
  --max-cost <usd>
  --max-input-tokens <n>
  --max-output-tokens <n>
  --max-duration-ms <n>
  --allow-external-writes  Reserve external-write policy category (real effects unsupported in 0.8)
  --allow-destructive      Reserve destructive policy category (real effects unsupported in 0.8)
  --trust-project          Trust this workspace and its verification scripts for execution
  --no-memory              Disable project-memory reads and writes

Output:
  --dry-run  --explain  --json  --config <path>  --cwd <path>
`;
