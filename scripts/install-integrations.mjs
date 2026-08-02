#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runIntegrationCommand } from "./integrations/installer.mjs";

const HELP = `Install native Super Router skills/plugins

Usage:
  super-router integrations <install|uninstall> <target> [options]

Source checkout:
  node scripts/install-integrations.mjs <install|uninstall> <target> [options]

Targets:
  --codex         Install the Codex skill
  --claude-code   Install the Claude Code standalone skill
  --all           Install both integrations

Options:
  --scope <user|project>  Installation scope (default: user)
  --project-dir <path>    Existing project root; required with project scope
  --dry-run               Print the intended result without writing
  --force                 Replace only conflicting or modified managed paths
  --help                   Show this help

The installer copies a fixed allowlist of integration files. It never copies configuration,
environment files, provider credentials, telemetry, or memory.`;

export function parseInstallerArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const action = argv[0];
  if (action !== "install" && action !== "uninstall") {
    throw new Error("first argument must be install or uninstall");
  }

  const integrations = new Set();
  let scope = "user";
  let projectDir;
  let dryRun = false;
  let force = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--codex":
        integrations.add("codex");
        break;
      case "--claude-code":
        integrations.add("claude-code");
        break;
      case "--all":
        integrations.add("codex");
        integrations.add("claude-code");
        break;
      case "--scope": {
        const value = argv[index + 1];
        if (value !== "user" && value !== "project") {
          throw new Error("--scope must be user or project");
        }
        scope = value;
        index += 1;
        break;
      }
      case "--project-dir":
        projectDir = requiredValue(argv, index, argument);
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (integrations.size === 0) throw new Error("choose --codex, --claude-code, or --all");
  if (scope === "project" && !projectDir) {
    throw new Error("--project-dir is required with --scope project");
  }
  if (scope === "user" && projectDir) {
    throw new Error("--project-dir is only valid with --scope project");
  }

  return {
    action,
    integrations: [...integrations],
    scope,
    ...(projectDir ? { projectDir } : {}),
    dryRun,
    force,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseInstallerArguments(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const results = await runIntegrationCommand(options);
  for (const result of results) {
    process.stdout.write(`${result.label}: ${result.status} (${result.target})\n`);
  }
  return 0;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`super-router integration installer: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
