# Super Router skill

This skill teaches compatible coding agents when and how to call the Super Router CLI. The CLI is
the source of truth for decomposition, routing, budgets, execution, and verification; the Markdown
file alone does not execute agents or switch models.

From the current source checkout, copy this directory to a supported personal or project skills
directory and run the CLI with Bun. After a scoped npm release exists, install
`@dmarigliano/super-router`; it provides the `super-router` binary. The unscoped npm package is
unrelated. Run `bun run src/cli.ts doctor` from the source checkout, or `super-router doctor` after
a scoped global installation, to verify the runtime and provider adapters.

Claude Code and Codex subscription CLIs are the preferred coding runtimes; Codex is disabled by
default and, when enabled, has a coarse provider-controlled sandbox rather than an exact tool
allowlist. Selected agent/skill instructions are embedded as bounded prompt data; provider-native
Agent/Skill activation is disabled.

Anthropic/OpenAI BYOK adapters are optional non-streaming, text-only fallbacks: they can receive those
prompt instructions, but cannot execute provider tools or mutate the workspace. Memory and telemetry
stay in project-scoped state outside the repository by default; a trusted state-root override can
change that location. Every `run`, including `run --dry-run`, requires `--trust-project`.
