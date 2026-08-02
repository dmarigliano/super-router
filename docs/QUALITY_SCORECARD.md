# Quality scorecard

## Assessment scope

Assessment date: 2026-08-02.

This scorecard evaluates the current source tree as a **supervised, local-first,
community open source 0.8 MVP**. It does not rate Super Router as an unattended
production control plane, a hosted service, or a proven cost-saving system.

The scale is intentionally conservative:

| Score | Meaning |
| --- | --- |
| 10 | Independently validated, production-proven, stable, and operationally mature |
| 8 | Strong executable MVP with reproducible evidence, safe defaults, and bounded/documented gaps |
| 6 | Useful partial implementation with important paths simulated or missing |
| 4 | Architecture/prototype with limited end-to-end behavior |
| 2 | Mostly positioning or scaffolding |

Scores of 8 or more require implementation, deterministic tests, failure
handling, and public documentation. A roadmap item is not evidence.

## Summary

| Criterion | Score | Conservative verdict |
| --- | ---: | --- |
| Idea and positioning | **9.0/10** | Distinct and coherently positioned around cost per accepted task while labeling the 0.8 selector as bounded primary-call optimization |
| Clarity of intended architecture | **8.8/10** | Contracts, trust boundaries, provider strategy, execution flow, and residual gaps are documented consistently |
| Real implementation | **8.5/10** | The CLI and library execute the intake-to-verification pipeline with real adapters and deterministic doubles |
| Reliability | **8.2/10** | Strong local gates, bounded runtime behavior, capability revalidation, and end-to-end tests; durable recovery/live conformance remain open |
| Operational security | **8.0/10** | Defensible for supervised local use with least privilege; not sufficient for unattended production |
| Open source readiness | **8.2/10** | Public repository history is preserved and hosted CI/CodeQL pass; npm publication, tag/release, and stronger repository controls remain pending |

The minimum is therefore **8.0/10 within the stated MVP scope**. This is not a
claim that every subdimension or production deployment deserves 8/10.

## Verification snapshot

Reproduced locally during candidate work through 2026-08-02 with Bun 1.3.14:

```text
bun run check
```

Result on the final local candidate: strict TypeScript, Biome, 306 deterministic
tests, 46/46 intake eval cases, and the CLI/library/declaration build passed.
The public merge commit
[`b056193`](https://github.com/dmarigliano/super-router/commit/b0561930bba4b0ff21b0f398c9aeb025234357e1)
also passed hosted [CI](https://github.com/dmarigliano/super-router/actions/runs/30730972945)
and [CodeQL](https://github.com/dmarigliano/super-router/actions/runs/30730972926).

The publication allowlist was also reproduced with:

```text
npm pack --ignore-scripts --dry-run
```

Result: the final local candidate contained 91 allowlisted files, including the
CLI, library bundles, declarations, docs, examples, skills, acknowledgments,
native integrations, and their fixed installer scripts. The dry-run artifact
was approximately 0.56 MB packed and 2.42 MB unpacked. The tarball installed
with lifecycle scripts disabled; version, library import, and managed
integration install/uninstall checks passed. No package was published.

A live Codex path was also reproduced on macOS with Node 26.0.0, Codex
0.146.0-alpha.9.2, ChatGPT authentication, and `gpt-5.6-sol`. `doctor` reported
the explicit provider healthy. A real read-only objective through the binary
installed from the local 0.8.0 tarball verified all three nodes and reached
task acceptance. Claude Code 2.1.220 was installed but not authenticated, so no
live Claude execution was claimed. See
[compatibility evidence](COMPATIBILITY.md) for the exact boundary and token
observation.

That Codex run reported 72,849 input tokens (59,392 cached), 875 output tokens,
and 96 reasoning tokens against a pre-run estimate of 446 input tokens. It
shows the adapter path worked, but it does not validate token economy or
calibration and is not a benchmark. The packed-candidate run separately
reported 84,094 input tokens (69,120 cached), 527 output tokens, and 14
reasoning tokens against 1,469 summed node estimates. Hosted CI and CodeQL are
now proven for the merge commit; branch protection, npm publication, a tag and
GitHub release, and external security review remain separate gates.

## 1. Idea and positioning — 9.0/10

### Evidence

- [README](../README.md) defines a local-first orchestration control plane, not
  an LLM proxy, and makes **cost per accepted task** the objective.
- [Architecture decisions](ARCHITECTURE.md) fix the provider-agnostic core,
  subscription-first coding runtimes, narrow BYOK fallback, progressive local
  state, human authority, and community OSS boundary.
- [Provider guide](PROVIDERS.md) separates Claude Code/Codex subscription CLIs
  from Anthropic/OpenAI metered text-only HTTP execution.
- [Simplicity and compression policies](../src/policies/) implement bounded
  ideas inspired by Ponytail and Caveman; [local memory](../src/memory/local-memory.ts)
  exposes lexical-relevance-gated search, timeline, and explicit retrieval
  inspired by Claude-Mem without claiming those projects are bundled.
- [Policy tests](../tests/policies.test.ts) verify that token-saving behavior
  does not erase approvals, errors, or high-risk controls.
- [Route optimizer](../src/routing/optimizer.ts) selects the lowest predicted
  primary-call-cost combination of model, effort, agent, and skills above the
  quality floor inside an explicit bounded candidate space: at most four
  automatic agents and eight automatic skills, with every valid subset of those
  skills evaluated (at most 256 per model/effort/agent combination).
  Focused tests cover the token tie-break, bounded escalation, non-prefix
  least-cost combinations, general capabilities, and the enumeration cap.
- Token volume is explicitly a conservative provider-neutral heuristic rather
  than a billing tokenizer, preventing the positioning from depending on false
  precision.
- The reproduced Codex token-accounting gap is published rather than converted
  into a savings claim.

### Why it is not higher

- Economic superiority is a hypothesis, not a reproduced benchmark against an
  always-premium baseline.
- Model price and quality priors are operator configuration, not a live,
  calibrated catalog.
- Planner weights are fixed per-node cost ceilings. Unused budget is not
  rebalanced across nodes, so a globally affordable plan can still reject a
  stage whose local share is too small; safe rebalancing must preserve retry
  and fallback reservations for the remaining DAG.
- Learned routing remains deliberately absent; outcome-driven calibration is
  future evidence work.

## 2. Architecture clarity — 8.8/10

### Evidence

- [Typed contracts](../src/contracts.ts) define task, DAG, route, capability,
  usage, verification, provider, and result boundaries.
- [Architecture](ARCHITECTURE.md) documents the end-to-end data flow, component
  responsibilities, safety invariants, implementation status, and open design
  decisions.
- [Threat model](THREAT_MODEL.md) enumerates assets, actors, trust boundaries,
  24 threats, implemented controls, and gaps without converting requirements
  into claims.
- [Configuration loader](../src/config.ts) expresses a clear precedence and
  trust split between explicit/user provider catalogs and untrusted project
  preferences.
- [Planner](../src/planning/decomposer.ts),
  [optimizer](../src/routing/optimizer.ts),
  [scheduler](../src/runtime/scheduler.ts), and
  [orchestrator](../src/orchestrator.ts) are separate modules connected through
  the public contracts.
- Architecture documentation distinguishes hard `--provider` routing from soft
  `--prefer-provider`, prompt-materialized capabilities from native runtime
  activation, and adversarial review from independently implemented review.

### Why it is not higher

- Architecture decision records and public schema/version migration rules do
  not yet exist.
- The clone-aware project namespace has no automatic migration from the earlier
  remote-only identifier.
- Provider privacy/residency is documented as a gap rather than encoded into
  route eligibility.
- Durable checkpoint/resume and effect-level mediation do not yet have final
  contracts.

## 3. Real implementation — 8.5/10

### Evidence

- [SuperRouter](../src/orchestrator.ts) connects prompt bounds, deterministic
  intake, project inspection, DAG planning, capability discovery, route
  optimization, bounded prompt materialization, top-two verified memory
  document retrieval plus bounded residual summaries, scheduler execution,
  step verification, task-level acceptance, telemetry, and accepted-run-only
  memory writes.
- The executable exposes `plan`, `run`, `doctor`, `capabilities`, `stats`,
  `integrations`, `help`, and `version`, including mandatory project trust for
  `run`, hard/soft provider controls, effect-zero dry-run simulation with
  explicit `simulated` success state, interactive approval, and a fixed native
  integration installer boundary.
- Repository-aware adapters exist for
  [Claude Code](../src/adapters/claude-code.ts) and
  [Codex](../src/adapters/codex.ts); bounded BYOK adapters exist for
  [Anthropic](../src/adapters/anthropic-api.ts) and
  [OpenAI](../src/adapters/openai-api.ts).
- [Orchestrator/CLI integration tests](../tests/orchestrator-cli.test.ts) cover
  dry planning; non-persistent scheduler simulation that never reports
  structural success as `verified`, invokes no real/custom verifier, produces
  no acceptance or `VerificationResult` evidence, and preserves genuine
  planning, prompt, and budget failures; real-run automatic verification wiring;
  overrides, prompt limits, successful/failed runs, telemetry, bounded handoffs,
  two-run full-memory reuse, task-level acceptance, accepted-run-only memory,
  and spawned CLI output without paid runtimes.
- [BYOK tests](../tests/byok-adapters.test.ts) validate official request shapes,
  normalized usage, cancellation, response bounds, redaction, prompt-delivered
  capabilities, and refusal to claim tools or workspace mutation.
- `bun run eval` evaluates checked-in multilingual intake cases, including
  ordered and repeated action sequences, from
  [evals/intake-cases.json](../evals/intake-cases.json).

### Why it is not higher

- The classifier/decomposer are deterministic heuristics, not a general
  ambiguity-resolution dialogue. Their multi-intent support is limited to
  recognized explicit action signals.
- Automatic memory retrieval expands only the top two verified search hits; it
  can retain bounded summaries for other matching hits, but does not traverse
  timeline neighborhoods or yet prove a token/quality gain against a no-memory
  baseline.
- One live Codex/ChatGPT-authenticated path succeeded, but it is not a
  cross-version/provider conformance suite; Claude remained unauthenticated.
- Provider privacy policy, durable resume, and learned outcome calibration are
  not implemented.

## 4. Reliability — 8.2/10

### Evidence

- [Scheduler](../src/runtime/scheduler.ts) enforces dependencies, concurrency,
  global/per-step attempts, conservative token/cost/duration reservations,
  fallback reauthorization, abort handling, verification states, and dependency
  failure propagation.
- The execution boundary rejects plans above 64 nodes, depth 16, fan-out 16, or
  256 dependency edges before checking or invoking an adapter. It also applies
  per-node and plan-wide count/character bounds to verification commands and
  expected artifact paths.
- [Runtime hardening tests](../tests/runtime-hardening.test.ts) cover unknown
  usage reservation, attempt ceilings, all DAG/command/path ceilings, fallback
  permission/tool checks, capability validation, and real workspace-change
  evidence.
- Project inspection bounds each synchronous Git probe to 1.5 seconds and 64
  KiB, with focused tests proving timeout failure falls back safely.
- [Capability validation](../src/routing/capability-validation.ts) is rerun from
  a refreshed registry before primary and fallback attempts; its focused tests
  include disappearing, incompatible, oversized, or mismatched prompt
  capabilities.
- [Route optimizer](../src/routing/optimizer.ts) reserves a provider-diverse
  fallback when two fallback slots and a qualifying alternative provider are
  available; [optimizer tests](../tests/core-routing-optimizer.test.ts) verify
  both diversity and the configured fallback cap.
- [Process runner](../src/adapters/process-runner.ts) bounds output/time and
  terminates descendant process groups; adapter tests exercise cancellation and
  ephemeral sessions.
- [Verification runner](../src/runtime/verification.ts) executes only validated
  commands in a replacement environment, records objective checks, and fails
  review nodes closed unless exactly one semantic PASS/FAIL verdict is present.
- [Orchestrator](../src/orchestrator.ts) starts JSONL retention pruning once,
  awaits it before public operations, and treats cleanup failure as non-fatal;
  focused tests cover both removal and failure isolation.
- The complete local gate is defined once as `bun run check`, and CI invokes
  that same command with a frozen lockfile.
- Memory/index/document reads and telemetry statistics have explicit byte,
  record, file, and render bounds with truncation reporting. Retrieval remains
  a bounded linear scan rather than a performance-optimized store.

### Why it is not higher

- Interrupted DAGs cannot be resumed from durable checkpoints.
- Live provider outages, rate limits, model drift, and cross-platform behavior
  are not covered by the deterministic offline suite.
- The intake eval suite measures deterministic classification/action ordering,
  not accepted-task quality or economic routing outcomes.
- Adversarial review can reuse the author's provider/model; independently
  implemented review is available only through a caller callback.
- Subscription CLI capture is byte-bounded, but its approximate output-token
  instruction is not a hard provider token stop.
- Descendant termination is process-group based on Unix and less complete on
  Windows, where only the direct child can be signaled by the MVP runner.
- No load, soak, crash-recovery, or latency benchmark has been published.

## 5. Operational security — 8.0/10

### Evidence

- [Operational policy](../src/security/policy.ts) classifies external and
  destructive work, while the scheduler refuses those real effects before
  provider access in 0.8 regardless of category flags. Critical local work
  requires a human callback.
- [CLI](../src/cli.ts) rejects critical approval non-interactively and asks once
  in a TTY; `run` also fails closed without `--trust-project`.
- [Configuration trust tests](../tests/trust-boundaries.test.ts) prove that a
  repository cannot replace providers/executables, enable external/destructive
  authority, or enable raw-prompt persistence.
- [Capability discovery](../src/routing/capability-registry.ts) uses bounded
  traversal, does not trust self-declared project/explicit-root metadata, caps
  project agents, namespaces collisions in favor of user capabilities, and
  materializes only bounded provider-scoped instruction payloads.
- Provider CLIs and deterministic verification use replacement, allowlisted
  environments; [adapter hardening tests](../tests/adapters-hardening.test.ts)
  demonstrate that unrelated credentials do not leak.
- Claude Code receives an exact safe-tool set, strict MCP isolation, disabled
  Chrome integration, and safe mode. Codex ignores ambient user configuration
  and repository rules while selecting a coarse provider-controlled sandbox.
  Both disable native Agent/Skill tools and tests assert that dangerous bypass
  flags are absent; Codex does not claim Claude's exact tool allowlist.
- [Security, memory, and telemetry tests](../tests/security-memory-telemetry.test.ts)
  cover canonical workspace/symlink boundaries, clean verification
  environments, secret redaction, memory provenance/integrity, and prompt
  omission.
- [HTTP client](../src/adapters/http-client.ts) requires credential-free HTTPS
  base URLs, size-bounds responses, propagates abort, and redacts configured
  keys.
- [Security policy](../SECURITY.md) and [threat model](THREAT_MODEL.md) provide a
  private reporting path and an explicit non-production posture.

### Scope limitation and residual risk

The score is 8.0 only for supervised local use with least privilege. It would
be below 8 for unattended production today because:

- Real external and destructive effects are intentionally unavailable until an
  effect broker and receipt verifier exist; category flags do not enable them.
- Approval is plan-node mediation, not interception of every filesystem,
  process, network, or remote effect inside a provider runtime.
- `TaskSpec.privacy` and `--no-memory` do not enforce provider egress, residency,
  or upstream retention.
- Approval decisions are not cryptographically bound to parameters, workspace
  revision, expiry, and one-time tokens.
- Provider executable identity is probed but not pinned/signed.
- Local state is permission-restricted/redacted but not encrypted or
  tamper-evident against a compromised user account.
- Per-read state bounds do not impose an aggregate disk quota; memory has no
  deletion/compaction command and telemetry cleanup is opportunistic.
- The project namespace is clone-aware, but migration from the earlier
  remote-only namespace is manual and linked worktrees intentionally share
  state.
- Token admission is heuristic; the default 16 MiB subscription CLI output cap
  is byte-hard rather than token-hard.
- `--trust-project` and plan-node approvals are declarations/gates, not syscall
  or network-effect mediation inside provider runtimes.
- Codex is disabled by default; when enabled, its coarse sandbox constrains an
  effect class rather than an exact command/tool set.
- There is no core network-domain sandbox or external security review.

## 6. Open source readiness — 8.0/10

### Evidence

- [MIT license](../LICENSE), [Code of Conduct](../CODE_OF_CONDUCT.md),
  [contribution guide](../CONTRIBUTING.md), [governance](../GOVERNANCE.md),
  [security policy](../SECURITY.md), [support policy](../SUPPORT.md),
  [changelog](../CHANGELOG.md), [acknowledgments](../ACKNOWLEDGMENTS.md),
  [compatibility evidence](COMPATIBILITY.md), and [roadmap](ROADMAP.md) cover
  the expected community lifecycle and attribution boundary. `CODEOWNERS`
  records bootstrap ownership without claiming that branch protection is
  configured.
- Bug/feature templates and the pull request template request reproductions,
  evidence, safety/economic impact, and sanitized data.
- CI uses a frozen lockfile, the full local gate, an explicit Node 20
  binary/library smoke, production dependency audit, and package dry-run;
  GitHub Actions are pinned to commit SHAs.
- CodeQL uses extended JavaScript/TypeScript queries, and Dependabot covers npm
  plus GitHub Actions.
- [Package metadata](../package.json) uses the non-conflicting scoped name
  `@dmarigliano/super-router`, exports the library, retains the `super-router`
  binary, declares public access, and includes docs, examples, skills, native
  integrations, their fixed installer scripts, governance/community files, and
  the safe configuration example in the package allowlist.
- [Provider example](../examples/providers.config.json) is schema-valid and
  deliberately keeps metered APIs disabled until explicitly configured.
- Installers use the scoped package and validate the requested version.

### Why it is not higher

- The two unsupported prototype commits are preserved and the candidate was
  reconciled on top of them through a normal pull request. Hosted CI and CodeQL
  passed, but the candidate has not yet been tagged or released.
- No scoped npm release is claimed as published.
- Branch protection, private vulnerability reporting, and repository security
  settings require verification on GitHub.
- Releases are not yet signed or accompanied by provenance/SBOM artifacts.

## Residual gates

Completed on 2026-08-02: the candidate was reconciled as a descendant of the
preserved prototype history without force-push, merged through PR #1, and
observed passing hosted CI and CodeQL on the resulting `main` commit.

| Priority | Gate | Effect on score |
| --- | --- | --- |
| Before publication | Rerun pack/install checks and verify npm/GitHub release artifacts | Converts source evidence into distribution evidence |
| Before enabling external, destructive, or unattended effects | Parameter-bound approval tokens, enforceable effect mediation, idempotency, and verified receipts | Required for production operational security ≥ 8 |
| Before sensitive provider routing | Enforce privacy/residency/egress policy on primary and fallback routes | Required for sensitive-data claims |
| Before 1.0 | Durable checkpoint/resume, versioned project-namespace migration, live adapter conformance, load/recovery benchmarks | Raises reliability beyond MVP |
| Before savings claims | Versioned price freshness and accepted-task evals against baselines | Required to validate positioning economically |
| Before stable release | Protected branch, signed provenance, incident drill, external security review | Raises OSS/security maturity toward 9–10 |

## Final judgment

The source has crossed from architecture prototype into a strong, executable
open source MVP. The reproduced local gate supports at least 8/10 in all six
requested criteria **for supervised local development**. The scorecard
deliberately does not extend that conclusion to unattended production,
sensitive-data routing, live-provider compatibility, or demonstrated savings.
