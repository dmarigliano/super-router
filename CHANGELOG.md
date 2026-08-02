# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
after the 1.0 release. During `0.x`, minor versions may include breaking changes.

## [Unreleased]

No changes recorded yet.

## [0.8.0] - 2026-08-01

Release-candidate source entry. This changelog does not claim that the npm
package, Git tag, or GitHub release already exists; verify each distribution
channel independently before installation.

### Added

- Bootstrap governance and ownership policy, security policy, threat model,
  contribution guidance, issue templates, pull request template, CI, CodeQL,
  and Dependabot setup.
- Contract-first records for tasks, plans, routes, capabilities, execution,
  verification, usage, providers, and configuration.
- Bun-based development, type-checking, linting, evaluation, testing, and build
  gates.
- End-to-end intake, DAG planning, capability discovery, deterministic routing,
  bounded scheduling, verification, telemetry, and verified-memory pipeline.
- Ordered and repeated multi-intent action preservation, including sequential
  `review -> fix -> review` plans and deterministic verification after mutating
  blocks.
- Provider-scoped agent/skill discovery with bounded instruction
  materialization in the provider prompt; provider-native Agent/Skill tools are
  deliberately disabled.
- Claude Code and Codex subscription CLI adapters with ephemeral execution,
  cancellation, bounded output, and normalized usage.
- Anthropic Messages and OpenAI Responses BYOK adapters for bounded,
  non-streaming, text-only fallback stages. They reject provider tools and
  workspace mutation but can consume selected capability instructions as prompt
  text.
- Strict configuration validation and separation between untrusted project
  preferences and trusted explicit provider catalogs.
- Local progressive memory and redacted telemetry under a project namespace
  outside the repository by default; a trusted environment override can change
  the state root.
- Lexical-relevance-gated automatic retrieval of at most two verified
  full-memory documents for a related root step, with non-duplicated residual
  summaries sharing the same 12,000-character/context-budget ceiling and
  untrusted-data prompt framing.
- Task-level acceptance evaluation after step verification, covering required
  command, policy, artifact, and human criteria; incomplete evidence ends in
  `needs-escalation` and is not persisted as a verified memory.
- Interactive one-time human gates for classified
  critical/external/destructive plan nodes. Critical local work may continue
  after approval; real external/destructive nodes are refused before provider
  access in 0.8 because no effect broker or receipt verifier exists.
- Explicit `run` workspace trust gate before the scheduler invokes a provider
  or repository verification command.
- Separate soft `--prefer-provider` and hard `--provider` controls; the hard
  form disables cross-provider fallback.
- Effect-zero `run --dry-run` scheduler simulation with `simulated: true` and
  terminal state `simulated` for structural success, never `verified`. It runs
  no provider, built-in/custom verifier, approval, artifact effect, task-level
  acceptance, telemetry write, or memory write; it creates no acceptance or
  `VerificationResult` evidence, while real planning, prompt, and budget
  failures retain their actual states. `plan` remains a separate structural
  preview.
- Conservative provider-neutral token estimation for admission/reservation and
  fail-closed semantic PASS/FAIL review verdicts.
- Deterministic provider doubles and end-to-end CLI/orchestrator tests.
- Skills-only Codex and Claude Code integration bundles plus a fixed,
  collision-aware installer exposed through `super-router integrations` after
  package installation and through a checked-in Node entry point from source.
- Compatibility evidence for one authenticated live Codex path, including the
  observed token-estimation gap, and explicit acknowledgment/non-affiliation
  documentation for conceptual influences and AI-assisted development.

### Changed

- Public documentation now records the provider-agnostic core,
  subscription-first strategy, text-only BYOK boundary, local state paths,
  critical human gates, and community OSS scope without presenting roadmap work
  as shipped.
- Project state identity now includes the canonical local Git common directory
  plus remote. Linked worktrees share state, while independent clones of one
  remote are isolated. Existing remote-only namespaces are not migrated
  automatically; use `doctor` and back up state. A plain directory copy is
  insufficient because records embed `projectId`, and 0.8 has no migration
  command.
- Selected `@dmarigliano/super-router` as the canonical npm package candidate
  while retaining `super-router` as the CLI binary. The unscoped npm package is
  unrelated, and this entry does not claim the scoped 0.8.0 package is already
  published.

### Security

- Added project capability trust caps, collision namespacing, provider fallback
  reauthorization, workspace/symlink validation, prompt/output bounds,
  credential redaction, clean verification environments, a narrow Claude tool
  allowlist, coarse Codex sandbox flags, generic DAG ceilings, runtime capability/prompt-payload
  revalidation, per-node/plan verification-command and artifact-path ceilings,
  bounded Git probes, bounded memory documents/index reads, bounded telemetry
  stats, and opportunistic telemetry retention pruning.

### Known limitations

- Version 0.8 does not provide durable DAG resume, cryptographically bound
  approval tokens, external/destructive effect execution or receipts,
  effect-level provider mediation,
  provider privacy/residency routing, executable signing,
  encrypted/tamper-evident state, background retention for idle state, a core
  network sandbox, signed releases, or an external security review.
- Multi-intent parsing is deterministic action-signal recognition, not general
  semantic clause understanding. Review nodes may reuse the author
  provider/model unless the caller supplies an independently implemented
  reviewer callback.
- Memory uses bounded linear JSONL scans rather than an indexed/vector store,
  has no aggregate disk quota or deletion/compaction command, and project
  namespace migration is manual.
- Token estimates are not provider tokenizer results. Claude/Codex output uses
  a default 16 MiB transport cap and is only approximately instructed by token
  budget; this is not a hard provider output-token stop.
- Cancellation uses descendant process groups on Unix where possible; the
  Windows runner can signal only the direct child.
- Codex is disabled by default; when enabled, its provider-controlled sandbox
  constrains `read-only` versus `workspace-write`, not an exact command/tool
  allowlist.
- Model prices, identifiers, quality priors, and live adapter compatibility are
  operator-maintained configuration rather than a live certified catalog.

### Historical repository context

- Commits [`180f841`](https://github.com/dmarigliano/super-router/commit/180f8414b3602aaadfb89286cb69add4ca0cabf9)
  and [`4c06f75`](https://github.com/dmarigliano/super-router/commit/4c06f756229d475cd0f953f40a2ee2a17974cd4e)
  are preserved as an unsupported pre-release prototype. They are not a
  supported 0.8 runtime or evidence of a prior public release.
- That prototype's manifest used version `1.0.0`, but
  `@dmarigliano/super-router@1.0.0` was never published to npm. The historical
  manifest number is not a SemVer predecessor or successor of the supported
  package line.

[Unreleased]: https://github.com/dmarigliano/super-router/commits/main
[0.8.0]: https://github.com/dmarigliano/super-router/releases/tag/v0.8.0
