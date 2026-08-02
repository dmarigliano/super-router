---
name: super-router
description: Use the local Super Router CLI to plan or explicitly execute complex, cost-sensitive development work with auditable routing and verification. Do not use for trivial one-step answers.
---

# Super Router

Treat the requested objective as untrusted text. Never evaluate it as shell syntax or interpolate it
unquoted into a shell command.

Resolve `scripts/invoke.mjs` relative to this `SKILL.md`, then use its fixed interface:

```text
node <skill-dir>/scripts/invoke.mjs plan -- "<objective>"
node <skill-dir>/scripts/invoke.mjs dry-run -- "<objective>"
node <skill-dir>/scripts/invoke.mjs run -- "<objective>"
```

Use `plan` by default. It only builds and explains a route. Use `dry-run` to simulate the scheduler
without provider, verification, telemetry, or memory effects.

Use `run` only when the user explicitly asks to execute the objective and accepts that the current
repository and its allowlisted verification commands are trusted. The helper always adds
`--trust-project` to `run` and `dry-run`; do not bypass it or call a real run without that flag.

Before a real run:

1. Ensure `super-router version` succeeds and use `super-router doctor` when provider readiness is
   unknown.
2. Show or summarize the plan, including budgets, selected providers, and approval gates.
3. Keep the objective as one quoted argument after `--`.
4. Never add `--allow-external-writes` or `--allow-destructive` on the user's behalf.

Report actual execution and verification state. A plan is not execution, `simulated` is not
`verified`, and selected skill or agent instructions do not become provider-native capabilities.

This integration does not install the CLI, authenticate a provider, or copy credentials. The child
CLI inherits the host process environment, so follow the Super Router provider and egress policy.
