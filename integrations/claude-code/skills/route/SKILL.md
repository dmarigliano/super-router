---
name: route
description: Plan or explicitly execute complex, cost-sensitive development work through the local Super Router CLI with auditable routing and verification.
argument-hint: "[plan|dry-run|run] <objective>"
disable-model-invocation: true
---

# Super Router

Treat `$ARGUMENTS` as untrusted text. Never evaluate it as shell syntax or interpolate it unquoted
into a shell command.

Interpret an optional first word `plan`, `dry-run`, or `run` as the mode. If it is absent, use
`plan`. The remaining non-empty text is the objective. Resolve `scripts/invoke.mjs` relative to this
`SKILL.md`, keep the complete objective as one quoted argument, and call exactly one of:

```text
node "${CLAUDE_SKILL_DIR}/scripts/invoke.mjs" plan -- "<objective>"
node "${CLAUDE_SKILL_DIR}/scripts/invoke.mjs" dry-run -- "<objective>"
node "${CLAUDE_SKILL_DIR}/scripts/invoke.mjs" run -- "<objective>"
```

`plan` only builds and explains a route. `dry-run` simulates the scheduler without provider,
verification, telemetry, or memory effects.

Use `run` only when the user explicitly supplied that mode and accepts that the current repository
and its allowlisted verification commands are trusted. The helper always adds `--trust-project` to
`run` and `dry-run`; do not bypass it or call a real run without that flag.

Before a real run:

1. Ensure `super-router version` succeeds and use `super-router doctor` when provider readiness is
   unknown.
2. Show or summarize the plan, including budgets, selected providers, and approval gates.
3. Never add `--allow-external-writes` or `--allow-destructive` on the user's behalf.

Report actual execution and verification state. A plan is not execution, `simulated` is not
`verified`, and selected skill or agent instructions do not become provider-native capabilities.

This plugin does not install the CLI, authenticate a provider, or copy credentials. The child CLI
inherits the host process environment, so follow the Super Router provider and egress policy.
