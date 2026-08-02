# Roadmap

## Product direction

Super Router is a community open source, provider-agnostic orchestration core
that turns a goal into verified work. Its long-term objective is to minimize
total expected accepted-task cost. Version 0.8 only minimizes predicted primary
provider-call cost inside a bounded candidate space. Quality, safety, privacy,
budget, and explicit user authority are constraints, not variables to trade
away for token savings.

This is a living prioritization document, not a promise of dates, compatibility,
or hosted services. Source, tests, and release notes are authoritative for the
current implementation.

## Decisions that are not roadmap experiments

- Claude Code and Codex subscription CLIs are the preferred coding runtimes.
- Anthropic and OpenAI BYOK HTTP adapters are optional, metered, text-only
  fallbacks; broad tool execution does not belong in those adapters.
- Memory remains local-first, progressive, project-scoped, and outside the
  repository by default.
- Critical local actions retain human gates. External and destructive intents
  retain bound gates but their real effects remain refused until a broker and
  receipt verifier ship.
- Deterministic routing stays the safe default. A learned policy may only enter
  shadow evaluation after reproducible evidence.
- The local OSS core must remain useful without a hosted control plane.

## Shipped in 0.8 — executable local MVP

- [x] Strict task, plan, route, capability, usage, verification, provider, and
      configuration contracts.
- [x] Configuration precedence and separation between untrusted project
      preferences and trusted explicit provider catalogs.
- [x] Multilingual deterministic intake with risk, ambiguity, privacy, quality,
      and budget classification.
- [x] Token-aware single-node/DAG planning with dependency and budget
      validation.
- [x] Bounded local agent/skill discovery with trust caps and deterministic
      collision handling.
- [x] Quality-floor and predicted primary-call-cost route filtering inside the
      bounded candidate space, explanation, overrides, and bounded fallbacks.
- [x] Claude Code and Codex CLI adapters with structured argv, ephemeral
      sessions, time/output bounds, cancellation, and normalized usage.
- [x] Anthropic Messages and OpenAI Responses BYOK adapters with bounded,
      non-streaming, text-only execution and credential redaction.
- [x] DAG scheduling with concurrency, global attempts/budgets, fallback
      reauthorization, cancellation, and fail-closed verification states.
- [x] Generic execution-plan ceilings: 64 nodes, depth 16, fan-out 16, and 256
      dependency edges, validated before adapter access.
- [x] Allowlisted deterministic project checks, workspace-change evidence,
      optional independent review, and interactive critical-action gates.
- [x] Redacted JSONL telemetry and progressive verified memory in a trusted
      project namespace outside the repository, with opportunistic retention
      pruning.
- [x] End-to-end orchestration/CLI tests with deterministic provider doubles.
- [x] Bootstrap OSS governance/ownership, contribution, support, security,
      threat-model, CI, CodeQL, and dependency-update files.

Version 0.8 is not production hardened, a fully autonomous agent, a hosted
control plane, or evidence of guaranteed token savings.

## 0.9 focus — reliability and security evidence

The next release should deepen existing paths rather than multiply adapters.

- [ ] Durable checkpoints and safe resume/recovery for interrupted DAGs.
- [ ] Exact-action approval tokens bound to operation, target, parameters,
      workspace revision, expiry, and one-time consumption.
- [ ] Effect-level mediation or a documented enforceable sandbox boundary for
      filesystem, process, network, and remote mutations inside each CLI
      runtime.
- [ ] Idempotent external/destructive effect executor with before/after policy
      checks and machine-verifiable receipts.
- [ ] Stronger executable identity/path policy for CLI runtimes.
- [ ] Provider adapter conformance suite with opt-in live tests and sanitized
      fixtures.
- [ ] Rate-limit classification, circuit breakers, and explicit cross-provider
      failover policy.
- [ ] Plan-wide cost-budget rebalancing that preserves retry and fallback
      reservations while allowing a stage to consume another stage's proven
      unused share.
- [ ] Enforced provider privacy/residency policy so task privacy constrains
      transmission, fallback, and retention boundaries rather than only local
      memory.
- [ ] More deterministic verifiers for security, compatibility, performance,
      and non-code artifacts.
- [ ] Prompt-injection, path/symlink, cancellation, memory-poisoning,
      confused-deputy, and late-effect adversarial evals.
- [ ] Memory export/deletion UX, background retention operations for idle state,
      and documented recovery/backup behavior.
- [ ] Reproducible package contents, provenance attestations, and signed release
      artifacts.
- [ ] Published compatibility matrix for supported Claude Code, Codex, Bun,
      Node.js, and operating-system versions.

## 0.10 focus — prove economic routing

The objective is evidence that routing lowers accepted-task cost without a
material quality or safety regression.

- [ ] Versioned pricing/capability metadata with freshness checks.
- [ ] Provider-reported input, output, reasoning, and cached-token
      reconciliation against run reservations.
- [ ] Calibrated route scoring from eval outcomes rather than configured priors
      alone.
- [ ] Champion/challenger evaluation for feedback, effort, model, specialist,
      and replan escalation choices.
- [ ] Measured Ponytail-style minimum-sufficient-solution policy.
- [ ] Measured Caveman-style compression enabled only when net token savings are
      positive and approvals/errors remain visible.
- [ ] Deeper Claude-Mem-style progressive retrieval with poisoning/staleness
      tests and explicit full-record selection.
- [ ] Local report for accepted-task cost, pass rate, orchestration overhead,
      cache rate, retries, and quality deltas.
- [ ] At least 150 representative Portuguese and English evaluation tasks with
      community-reviewable expected outcomes.

Targets are hypotheses until reproduced:

- Median accepted-task cost at least 25% below an always-premium baseline.
- No more than a two percentage-point success-rate reduction per task category.
- Median orchestration overhead below 10% of total tokens.
- Zero silent budget overruns, authority expansion, or nonexistent capability
  selection in the evaluation suite.

## Toward 1.0 — stable community core

- [ ] Stable, versioned public contracts and migration policy.
- [ ] External security review of policy, execution, adapters, and memory.
- [ ] Incident response and credential-rotation runbooks exercised in a drill.
- [ ] Reliability, cancellation, recovery, and resource benchmarks.
- [ ] Evidence-backed quality/cost report with reproducible methodology.
- [ ] Maintainer and reviewer path for trusted adapters and capability
      manifests.
- [ ] Documented release, deprecation, and vulnerability-support policy.

## Possible post-1.0 work

Only with evidence and community demand:

- Policy learning in shadow mode with category guardrails and instant rollback.
- Team policy packs and opt-in shared capability registries.
- Sandboxed remote workers and distributed scheduling.
- Optional hosted observability that remains compatible with and unnecessary
  for the local OSS runtime.

## How to influence the roadmap

Open a focused feature request describing:

- user outcome and concrete acceptance criteria;
- security, privacy, and human-approval impact;
- quality floor and failure behavior;
- cost/token hypothesis and a reproducible measurement plan;
- why the capability belongs in core, an adapter, or a separate integration.

Community contributions are welcome, but a checkbox is completed only with
implementation, deterministic tests, failure handling, and documentation. See
[CONTRIBUTING.md](../CONTRIBUTING.md) before proposing an implementation.
