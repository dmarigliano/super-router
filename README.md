# Super Router

[![CI](https://github.com/dmarigliano/super-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dmarigliano/super-router/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dmarigliano/super-router/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/dmarigliano/super-router/actions/workflows/codeql.yml)

> A local-first control plane that turns an objective into a verified execution plan and routes
> each step to the lowest predicted primary-call-cost combination of model, effort, agent, and
> skills that can meet its quality and safety requirements within an explicit bounded candidate
> space.

Super Router is not an LLM proxy and it does not claim that a printed plan is execution. It is an
open source orchestration engine for coding-agent runtimes. Its core contracts, planner, optimizer,
scheduler, verifier, and memory interfaces are provider-agnostic; provider-specific behavior stays
behind adapters. The engine classifies a task, creates a dependency graph, discovers installed
capabilities, materializes the selected agent/skill instructions into a bounded provider prompt,
prices candidate routes, executes authorized steps, verifies the result, escalates bounded failures,
and records redacted evidence.

## Project status

Current source version: **0.8.0 — executable local MVP and release candidate**. This repository does
not claim that 0.8.0 has already been published to npm; the `v0.8.0` Git tag and GitHub release do
exist. The public `main` source has passed its hosted
[CI](https://github.com/dmarigliano/super-router/actions/runs/30827438979) and
[CodeQL](https://github.com/dmarigliano/super-router/actions/runs/30827439097) checks and is usable
from a reviewed source checkout through the steps below.

| Capability | Status |
| --- | --- |
| Multilingual prompt intake and risk classification | Implemented |
| Ordered and repeated multi-intent DAG decomposition and dependency validation | Implemented deterministic MVP |
| Dynamic local agent/skill discovery and bounded prompt materialization | Implemented; no provider-native agent/skill activation |
| Cost/quality/effort route optimization | Implemented |
| Claude Code and Codex CLI adapters | Implemented |
| Planning, simulated dry-run, and route explanation | Implemented; structural success is `simulated`, never `verified` |
| Budget enforcement, bounded fallback, verification, and safety policy | Implemented |
| Critical human gates in interactive CLI and library callback | Implemented |
| Redacted JSONL telemetry and progressive local memory outside the repository by default | Implemented |
| Anthropic and OpenAI BYOK HTTP adapters | Implemented for non-streaming, text-only steps |
| Learned routing policy | Not implemented; deterministic policy remains the default |
| Hosted control plane or cloud memory | Outside the current local OSS runtime |

Model prices and quality priors are estimates supplied by configuration. They must be calibrated
against your provider agreement and eval suite before financial reporting.

## How it works

```text
prompt
  -> task contract (intent, risk, constraints, acceptance criteria, budget)
  -> dependency graph
  -> capability discovery and bounded prompt materialization
  -> route optimizer (quality floor first, then bounded predicted primary-call cost)
  -> selective context and project memory
  -> provider adapter
  -> deterministic verification
  -> retry / effort escalation / model fallback / human gate
  -> verified result, usage ledger, and redacted trace
```

The long-term product KPI is **cost per accepted task**, not raw token count. A complete metric
should include planning, repeated context, agents, tool output, checks, failed branches, and retries.
The 0.8 selector minimizes predicted primary provider-call cost inside its documented bounded
candidate space; it does not model failure probability or expected recovery cost. The runtime ledger
does account for attempts and conservative reservations, but does not monetize every local tool or
verification cost, so no savings claim is implied.

Tools are fixed eligibility requirements for each planned step, not economic candidates. Selective
project context and memory are admitted after routing and are enforced by the runtime prompt budget.

When a prompt contains several explicit actions, the deterministic intake preserves their order,
including repeated actions such as `review -> fix -> review`. The planner turns them into sequential
contracts and inserts deterministic verification after mutating work. This is an action-signal
parser, not a general semantic dialogue system; ambiguous scope still belongs with the caller.

## Quick start

Requirements:

- Node.js 20+
- Bun 1.1+
- At least one configured provider. An authenticated `claude` or `codex` subscription CLI is the
  recommended path.

```bash
git clone https://github.com/dmarigliano/super-router.git
cd super-router
bun install
bun run check

# Inspect the environment
bun run src/cli.ts doctor

# Explain the route without executing it
bun run src/cli.ts plan --explain "Corrija o timeout do login e adicione testes"

# Execute authorized local work and verify it. This explicitly trusts the
# workspace and its package/build/test scripts.
bun run src/cli.ts run --trust-project --max-cost 3 "Corrija o timeout do login e adicione testes"
```

The secure default enables Claude Code. To use Codex, or to opt in to metered Anthropic/OpenAI
fallbacks, start from the [trusted provider example](./examples/providers.config.json) and pass it
explicitly:

```bash
bun run src/cli.ts doctor --config ./examples/providers.config.json
bun run src/cli.ts plan --config ./examples/providers.config.json "Audit authentication code"
```

## Installation

The source checkout above is the current installation path. The 0.8.0 npm candidate is scoped as
`@dmarigliano/super-router` and installs the `super-router` binary. The unscoped npm name belongs to
another project; do not install it expecting this repository.

Only after 0.8.0 is published under the scoped name:

```bash
npm install --global @dmarigliano/super-router@0.8.0
```

The repository's `install.sh` and `install.ps1` invoke that same scoped npm package and therefore
also require the release to exist. From a source checkout after `bun run build`, invoke the bin
directly:

```bash
node ./bin/super-router.js doctor
```

After the scoped global installation exists:

```bash
super-router plan "Audit authentication code"
super-router run --trust-project "Add caching to the API"
super-router capabilities
super-router stats
```

Until `npm view @dmarigliano/super-router@0.8.0 version` succeeds, use the source-checkout commands
and do not treat the npm examples as evidence that a release exists.

## Codex and Claude Code integrations

The source candidate includes skills-only native bundles for Codex and Claude Code. They provide a
host-runtime entry point into an already installed `super-router` executable; they do not install a
provider runtime, authenticate an account, copy credentials, or bypass Super Router approval and
workspace-trust gates.

After a scoped package installation exists, preview and install both bundles for the current user:

```bash
super-router integrations install --all --scope user --dry-run
super-router integrations install --all --scope user
```

The installer also supports `--codex`, `--claude-code`, project scope with an explicit
`--project-dir`, and a managed `uninstall` action. From a reviewed source checkout, the equivalent
entry point is `node scripts/install-integrations.mjs ...`. Marketplace installation depends on a
public repository and release tag; both now exist as of `v0.8.0`, but the `super-router` executable
it wires up still comes from the npm package, so treat that step as pending publication. See
[the native integration guide](./integrations/README.md) for the exact Codex and Claude Code flows
and security boundary.

## Routing controls

```bash
--prefer-provider claude-code # soft preference; cross-provider fallback remains eligible
--provider claude-code        # hard requirement; disables cross-provider fallback
--model sonnet
--effort balanced          # economy | balanced | deep | max
--agent security-reviewer
--skill security-scan      # repeatable
--quality-floor 0.92
--max-cost 5
--max-input-tokens 120000
--max-output-tokens 30000
--max-duration-ms 1800000
```

`--provider` is a hard route constraint. `--prefer-provider` is only a preference and retains
eligible fallback providers. Both remain subject to availability, permissions, budgets, and safety
gates. An unknown agent or skill is rejected instead of being silently invented.

External writes and destructive actions are refused in real 0.8 runs. The
following forward-compatible flags record category-level authority for policy
inspection and simulation, but do not enable those effects:

```bash
--allow-external-writes
--allow-destructive
```

Only use these flags when the exact action is authorized. They neither approve
nor execute a particular action. Plan nodes classified as external or
destructive still receive a one-time human gate, then the real scheduler stops
before provider availability or execution because 0.8 has no effect broker and
receipt verifier. Critical local work can proceed after its concrete approval;
external/destructive work can only be inspected or simulated in this release.
The CLI fails closed when it cannot ask interactively.

Execution also requires `--trust-project`. This is separate from permission to modify files: it
acknowledges that the selected coding runtime and discovered verification commands may execute code
from the workspace. Planning, capability discovery, and `doctor` do not require that trust. Never
use the flag for a repository you have not reviewed; use a disposable OS sandbox instead.

The bundled Codex and Claude Code skills do not surface that choice: their wrapper adds
`--trust-project` to every `run` and `dry-run` invocation, and its argument contract accepts only a
mode and an objective, so there is no form that withholds the flag. `plan` never adds it. Treat
invoking those skills in a checkout as the same declaration this section describes, and make it from
the repository you intend to trust — the working directory decides whose code executes, not the mode
word. See [the native integration guide](./integrations/README.md) for the exact boundary.

The gate is at the plan-node/provider boundary, not a system-call proxy around a third-party coding
runtime. Keep the provider's own sandbox and permission prompts enabled for supported local work;
0.8 cannot intercept every effect a compromised runtime or prompt-injected tool might attempt.

`plan` builds and explains a route without executing providers or persisting a run or memory result.
`run --dry-run` exercises the scheduler through a simulation adapter and returns
`simulated: true`. A structurally successful simulated step and run use the terminal state
`simulated`, never `verified`. Dry-run does not invoke a provider, built-in verification command,
custom verifier, artifact effect, approval callback, telemetry write, or memory write, and it does
not create acceptance or `VerificationResult` evidence. Real planning, prompt-construction, and
budget failures retain their actual failure states rather than being relabeled as simulated. Because
dry-run enters the `run` contract, `--trust-project` remains mandatory.

Critical tasks receive an explicit approval node before the high-impact step. Examples include
production changes, credential or access-control changes, publishing or sending externally, and
destructive filesystem or database operations.

## Economy without quality collapse

Super Router uses several independent policies:

- **Minimum sufficient solution:** reuse project code, the standard library, native platform
  features, or existing dependencies before generating new abstractions.
- **Adaptive compression:** compact verbose handoffs and tool output while retaining raw artifacts.
  Security warnings, approvals, and diagnostic errors are not aggressively compressed.
- **Progressive memory:** for non-empty queries, the local store admits only metadata hits with
  lexical overlap before applying verification/recency bonuses. The orchestrator retrieves at most
  the top two verified documents, then fills any remaining shared 12,000-character/root-context
  budget with non-duplicated summaries of matching hits whose full documents were unavailable,
  omitted, or beyond the top two. It writes a new record only after step verification and
  task-level acceptance both pass.
- **Lazy skills:** rank metadata first, admit the top eight compatible automatic skill candidates,
  exhaustively compare their valid subsets (at most 256 combinations per model/effort/agent), then
  resolve only the selected instructions. Up to eight skills are embedded as bounded prompt data
  (4,096 characters per capability and 16,384 aggregate); the runtime does not activate
  provider-native agents or skills. Automatic agent search is independently capped at the top four
  compatible candidates per model.
- **Escalation ladder:** use bounded retries and configured fallback routes before raising effort,
  model capability, provider cost, or specialist overhead. When the attempt budget permits, the
  fallback set retains a provider-diverse route so an unavailable subscription runtime can reach
  an eligible BYOK text stage.
- **Deterministic checks first:** builds and tests are cheaper and more reliable than asking another
  model whether the first model succeeded.

These policies draw on concepts discussed by Ponytail, Caveman, Claude-Mem, and the broader
Everything Claude Code ecosystem, but the core does not bundle or require those projects, plugins,
or global hooks. See [Acknowledgments](./ACKNOWLEDGMENTS.md) for links, scope, and non-affiliation
statements.

## Configuration

[`super-router.config.example.json`](./super-router.config.example.json) is a safe project-local
configuration: it may tune routing and budgets but cannot define executables/providers or enable
external, destructive, or raw-prompt authority. Configuration is resolved in this order:

1. `--config <path>` (trusted explicit configuration).
2. `SUPER_ROUTER_CONFIG` (trusted explicit configuration).
3. `./super-router.config.json` (untrusted project-local preferences).
4. Secure built-in defaults.

A project-local file also cannot disable telemetry or memory. Silencing the redacted audit trail is
authority over evidence rather than a routing preference, so use a trusted configuration for a
permanent change or `--no-memory` for one ephemeral task.

Use the [explicit provider catalog](./examples/providers.config.json) only through `--config` or
`SUPER_ROUTER_CONFIG`. Credentials remain in the environment, never in JSON. See the
[provider guide](./docs/PROVIDERS.md) for the supported boundaries.

### Seeing the route decision

Subscription adapters carry zero incremental price in the default catalog, so every stage of a
default plan reports `$0.0000` and the selector's economics are invisible.
[`examples/priced-demo.config.json`](./examples/priced-demo.config.json) prices two routes so the
decision can be read directly. Its numbers are illustrative and are not a price list.

```bash
bun run src/cli.ts plan --config ./examples/priced-demo.config.json --quality-floor 0.88 \
  "Review the authentication module"
bun run src/cli.ts plan --config ./examples/priced-demo.config.json --quality-floor 0.95 \
  "Review the authentication module"
```

Raising the floor keeps the cheaper model and buys the quality with effort instead of switching to
the premium route, which is the escalation ladder described above.

### Estimate accuracy

The token estimator measures the prompt Super Router builds. A coding runtime also charges for its
own system prompt, ambient user instructions, the files the agent reads during the turn, and context
resent on later turns, so the reported input is expected to be much larger. That gap is recorded
rather than assumed: each step stores its reservation beside the provider-reported usage, and `stats`
prints the resulting ratio.

```text
Estimate accuracy vs provider: input=23.2x under output=13.3x over
  reserved input=4152 output=14999 | reported input=96123 output=1129
```

The line is omitted until at least one step has recorded both numbers. Once a provider has three
such observations, later reservations for it are scaled by the observed input ratio, which is what
makes `--max-cost` and `--max-input-tokens` bind against realistic figures instead of a prediction
already known to be low. Only ratios above 1 are applied: an observed overestimate must not shrink a
reservation, because the input reservation and `outputBudget` are ceilings rather than forecasts.
Ratios are clamped to a bounded range so a single pathological run cannot distort later estimates,
and with too little history no correction is applied at all.

Calibration narrows the error; it does not remove it. Treat the ratio as an operational signal, not
as billing-grade accounting.

Important defaults:

- Provider: Claude Code subscription CLI
- Profile: balanced
- Quality floor: 0.88
- Concurrent steps: 3
- Real external and destructive effects: unsupported in 0.8; category flags do not enable them
- Raw prompt persistence: disabled
- Progressive local memory and redacted telemetry outside the repository by default: enabled

Provider catalogs contain configurable price and quality priors. Subscription adapters use zero
incremental provider price in the default catalog; that represents routing accounting, not a claim
that the subscription is free. A route is eligible only if its predicted quality reaches the
task's floor. High-risk tasks raise the floor and may require adversarial review or human approval.
An explicit review node is a separate model call, but the optimizer may assign it the same provider
and model as the author. Provider/model independence exists only when the library caller supplies a
separate `independentReviewer` callback, and the caller is responsible for making that callback
genuinely independent.

## Provider strategy

| Adapter | Billing boundary | Intended use | Current limits |
| --- | --- | --- | --- |
| `claude-code` | Existing subscription/session | Preferred coding runtime | Requires the local `claude` CLI and its sandbox/authentication; selected capabilities are prompt text, not native agents/skills |
| `codex` | Existing subscription/session | Opt-in coding runtime; disabled by default | Requires an explicit model catalog and local CLI; sandbox is coarse/provider-controlled and selected capabilities are prompt text |
| `anthropic-api` | BYOK, metered HTTP | Optional fallback for eligible text stages | Non-streaming text only; no provider tools or workspace mutation; selected capability instructions may be prompt text |
| `openai-api` | BYOK, metered HTTP | Optional fallback for eligible text stages | Non-streaming Responses API text only; no provider tools or workspace mutation; selected capability instructions may be prompt text |

BYOK providers are disabled by default. Enable them only after exporting the matching key, checking
model identifiers and prices against your account, and running `super-router doctor`. The router
will not present a text-only HTTP response as tool execution or a code artifact.

## Local state and memory

By default, memory and telemetry are not written into the repository. They are namespaced by
project under the platform state directory (`~/Library/Application Support/super-router` on macOS,
`$XDG_STATE_HOME/super-router` or `~/.local/state/super-router` on Linux, and `%LOCALAPPDATA%` on
Windows). Set `SUPER_ROUTER_STATE_DIR` to choose another trusted location; the override is not
automatically prevented from pointing inside a repository, so keep it outside untrusted worktrees.

The store keeps redacted, provenance-tagged observations and is queried by project identity. Raw
prompts are not persisted by the current store. Recovered memory is reference data, may be stale,
and never grants authority over current code or explicit user instructions. Use `--no-memory` for
an ephemeral local-state task. This flag disables Super Router memory; it does not prevent the
selected Claude Code, Codex, Anthropic, or OpenAI provider from receiving the bounded prompt.

Project identity includes the canonical local Git common directory and the configured `origin`.
Linked worktrees that share a Git common directory therefore share a namespace, while independent
clones of the same remote do not. This replaces the earlier remote-derived namespace. There is no
automatic migration: after upgrading, `doctor` may show a new `projectId` and state directory, and
older memory may appear absent. Moving the Git common directory or changing `origin` can also change
the identifier. Back up the old state before any migration. A plain directory copy is insufficient
because memory records embed `projectId` provenance, and 0.8 provides no migration
command. The safest default is to retain the old directory as a separate backup; any one-off
migration must be audited and rewrite the namespace consistently.

The local store is intentionally bounded and simple, not a large-scale vector database. By default,
search/timeline scan at most the bounded 8 MiB/10,000-record JSONL tail, `get` accepts at most 100
document IDs, stored content is capped at 256,000 characters per document (with a bounded serialized
file), and prompt rendering stops at 24,000 characters. Lookup cost grows linearly within those
bounds. Telemetry statistics similarly cap the default scan at 400 files, 256 MiB total, one million
records, and 64 MiB per file, and report truncation instead of implying a complete lifetime total.

`telemetry.retentionDays` is enforced opportunistically when a router instance starts its first
public operation. Cleanup failure does not block planning or execution. There is no background
retention service, so long-idle state directories still need normal host-level lifecycle controls.

## Privacy and security

- Child processes are invoked with argument arrays and `shell: false`.
- Time, byte-output, retry, concurrency, cost, and conservative token-accounting limits are
  enforced at their documented boundaries. The provider-neutral token estimator is deliberately
  conservative and is not an exact Claude, Codex, Anthropic, or OpenAI tokenizer.
- Caller-supplied execution plans fail before adapter access above 64 nodes, depth 16, fan-out 16,
  or 256 edges. The same preflight bounds verification commands and expected artifact paths by
  count and character size at both node and plan scope.
- Claude Code receives an exact built-in tool set, no Chrome or ambient MCP configuration, and safe
  mode. Codex ignores ambient config/rules and selects a provider-controlled `read-only` or
  `workspace-write` sandbox; its CLI does not expose an equivalent exact tool/command allowlist.
  Both disable native Agent/Skill tools and receive selected capability instructions only in the
  prompt.
- Telemetry is append-only, redacted, and never persists raw prompts by default.
- Default memory and telemetry state live outside the repository and are separated by project
  identity.
- Verified memory stores provenance, confidence, and source revision where available.
- Recovered memory is treated as potentially stale and never overrides current code.
- Deterministic verification and Claude's built-in tools use narrow allowlists; dangerous
  verification shell constructs are rejected. Codex retains only its coarse provider sandbox.
- Provider runtimes keep their own sandbox and permission controls.

Read [`SECURITY.md`](./SECURITY.md) and [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) before
deploying Super Router in an unattended environment.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun run check
```

The CI workflow runs the same checks and an explicit Node 20 binary/library smoke. New 0.8 routing
behavior must test its quality floor and predicted primary-call cost; accepted-task economics need
broader outcome and retry evidence. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Evaluation principles

Every route should answer four independent questions:

1. Was the objective understood?
2. Is the dependency graph valid and complete?
3. Was the selected route economically appropriate?
4. Did the final artifact pass objective verification?

The primary KPI is cost per accepted task. Supporting metrics include first-pass success, quality
delta against an always-premium baseline, orchestration overhead, discarded tokens, useful
escalations, cache hit rate, manual overrides, rollback rate, and unauthorized-action count.

## Limitations

- The default classifier and decomposer are deterministic; they intentionally favor predictable,
  testable behavior over pretending to understand every possible prompt. They preserve ordered and
  repeated explicit action signals, but do not perform unrestricted semantic clause parsing.
- Provider pricing and model availability change. Keep the catalog current and versioned.
- Quality priors are starting assumptions, not universal benchmark results.
- The local CLI adapters depend on the behavior and authentication of installed third-party tools.
- Codex is disabled by default. When enabled, its sandbox limits a broad effect class rather than an
  exact command/tool set, so provider sandbox and approval behavior remain part of the trust base.
- The BYOK HTTP adapters are intentionally non-streaming and text-only; they cannot edit the
  workspace or run provider tools. Selected agent/skill instructions can only influence their prompt.
- `--no-memory` controls Super Router persistence, not provider transmission or upstream retention.
  Provider privacy/residency policy is not yet an optimizer constraint.
- The local JSONL state is permission-restricted and integrity-checked where supported, but it is
  not encrypted or tamper-evident against a compromised local account.
- Memory search/timeline and telemetry statistics are bounded linear scans. Truncation is explicit,
  but the MVP has no indexed/vector retrieval service or background state maintenance.
- Automatic full-document memory expansion is limited to the top two search hits; bounded
  summaries may represent other matching hits. Retrieval does not yet use timeline neighborhoods
  or demonstrate measured token/quality improvement against summary-only or no-memory baselines.
- Per-read limits are not an aggregate state-directory quota. Memory expiry filters retrieval but
  does not provide deletion/compaction, and telemetry retention runs only opportunistically.
- Human approval covers the classified plan-node action; it is not complete mediation of every
  filesystem, process, or network effect inside a provider runtime.
- `--trust-project` is a trust declaration, not a sandbox. Project package scripts, compiler
  plugins, and test configuration can execute arbitrary code with the invoking user's OS access.
- Input-token admission uses a conservative provider-neutral estimator, not an exact tokenizer, and
  it measures only the prompt Super Router builds. A coding runtime also charges for its own system
  prompt, ambient user instructions, every file the agent reads during the turn, and context resent
  on later turns, so the reported input is expected to be far above the estimate. On a measured
  three-node read-only Claude Code run the reservation was 4,152 input tokens against 96,123
  reported — 23x. That difference is a function of agent behaviour at runtime and cannot be computed
  from the prompt, so it is measured instead: see [Estimate accuracy](#estimate-accuracy) below.
  Claude Code and Codex receive an approximate output-token instruction, while their local process
  transport defaults to a 16 MiB capture cap; that byte cap is not a hard provider output-token
  stop. BYOK APIs use their provider-specific output-token request fields.
- Adversarial review nodes fail closed on a missing or negative semantic verdict, but may share the
  author's provider/model. A separately configured callback is required for actual independence.
- Dry-run writes neither telemetry nor memory. Structural success is reported as `simulated`, never
  `verified`; the simulation creates no acceptance or `VerificationResult` evidence and does not run
  built-in or custom verification. Real planning, prompt, and budget failures keep their actual
  terminal states.
- The project namespace changed to include local Git identity. Existing remote-only state is not
  migrated automatically, moving the common directory/changing `origin` can create a new namespace,
  and a plain directory copy does not rewrite embedded provenance.
- The MVP has no durable DAG checkpoint/resume, live paid-provider conformance matrix, published
  load/soak/crash-recovery benchmark, or learned outcome calibration.
- Planning assigns each node a fixed cost share from template weights. The scheduler enforces both
  that per-node ceiling and the global task ceiling, but 0.8 does not rebalance unused cost from one
  node to another; a globally affordable plan can therefore be rejected when one stage exceeds its
  initial share.
- Cancellation is best-effort at process boundaries. Unix uses a descendant process group where
  available; the Windows runner can signal only the direct child.
- A real result is successful only when every step verification and every required task-level
  acceptance criterion has evidence. Custom artifact criteria remain structural contracts rather
  than unrestricted semantic proof.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Provider configuration](./docs/PROVIDERS.md)
- [Threat model](./docs/THREAT_MODEL.md)
- [Quality scorecard](./docs/QUALITY_SCORECARD.md)
- [Compatibility evidence](./docs/COMPATIBILITY.md)
- [Roadmap](./docs/ROADMAP.md)
- [Acknowledgments](./ACKNOWLEDGMENTS.md)
- [Contributing](./CONTRIBUTING.md)
- [Governance](./GOVERNANCE.md)
- [Security policy](./SECURITY.md)
- [Support](./SUPPORT.md)

## License

[MIT](./LICENSE). Super Router is community-oriented open source: issues, focused pull requests,
adapter conformance tests, bilingual evals, and security review contributions are welcome. There is
no hosted service or commercial support commitment in this repository. Project and provider names
are used for identification only; no vendor or referenced project endorses Super Router.
