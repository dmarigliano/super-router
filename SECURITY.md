# Security Policy

Super Router can coordinate models, agents, skills, tools, local files, and
external providers. A routing or authorization defect can therefore have more
impact than an ordinary CLI bug. Please report suspected vulnerabilities
privately and avoid testing against systems or data you do not own.

## Supported versions

| Version | Status |
| --- | --- |
| `main` / `0.8.0` source candidate | Current MVP; security fixes accepted before release |
| `v0.8.0` / npm `0.8.0` | Supported only after the corresponding tag/package is actually published |
| Historical prototype commits | Unsupported |

The two preserved remote commits, `180f841` and `4c06f75`, are unsupported
pre-release prototype history. Their old manifest version `1.0.0` was never a
published `@dmarigliano/super-router@1.0.0` npm release. Do not use that number
to infer support or upgrade ordering.

The project has not reached 1.0. APIs may change, and implemented controls do
not make unattended production operation safe by default. Source and tests,
not roadmap text, define the current boundary.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/dmarigliano/super-router/security/advisories/new>

Do **not** open a public issue for a suspected vulnerability. Include, when
available:

- A concise description and expected impact.
- Affected version, commit, operating system, and runtime.
- Minimal reproduction steps or a proof of concept.
- Whether credentials, private prompts, files, memory, or external actions are
  exposed.
- Suggested mitigation, if known.
- Any publication timeline you are considering.

Remove real credentials and personal or customer data. Use synthetic examples.

## What to expect

The maintainers aim to:

1. Acknowledge a report within 3 business days.
2. Provide an initial assessment within 7 business days.
3. Coordinate a fix, release, and disclosure based on severity.

These are best-effort targets for an open source project, not a service-level
agreement. Please allow a reasonable remediation period before public
disclosure. Credit is offered when requested and appropriate.

## In scope

Examples include:

- Bypassing human approval, destructive-action, or external-write gates.
- Command, argument, path, prompt, or tool injection that crosses a trust
  boundary.
- Secret or private prompt leakage through logs, traces, memory, errors, or
  provider requests.
- Executing an undiscovered, disabled, untrusted, or substituted capability.
- Memory poisoning or cross-project memory disclosure.
- Budget enforcement bypass that causes uncontrolled provider spend.
- Unsafe fallback, retry, or escalation behavior.
- BYOK key disclosure, unsafe endpoint handling, or a text-only adapter claiming
  native tool/agent/skill execution or workspace mutation.
- Dependency, workflow, installer, or release supply-chain compromise.
- Denial of service caused by unbounded plans, output, concurrency, retries, or
  recursive orchestration.

## Generally out of scope

- Provider outages, model hallucinations, or upstream behavior with no Super
  Router control failure.
- Social engineering without a technical vulnerability.
- Reports that require possession of an already-compromised host account.
- Volumetric denial-of-service testing.
- Findings from automated scanners without a reproducible security impact.
- Vulnerabilities exclusively in an unsupported version.

Upstream issues may still be useful; report them to the affected provider or
dependency and tell us if Super Router can mitigate the risk.

## Safe research rules

- Test only with your own repositories, accounts, providers, and data.
- Do not access, retain, or modify another person's data.
- Do not degrade hosted services or create avoidable provider charges.
- Stop after demonstrating the minimum impact necessary.
- Share findings and artifacts only through the private reporting channel.

Good-faith research following these rules will not be pursued by the project
maintainers. This statement cannot authorize testing against third-party
systems or override their policies or applicable law.

## Security posture of the 0.8 MVP

The current implementation includes strict configuration validation, a trust
split between project and explicit provider configuration, a dependency-aware
budgeted scheduler, global attempt/budget accounting, cancellation propagation,
allowlisted project checks, workspace-change/symlink validation, redacted local
telemetry, and project-scoped verified memory outside the repository by default.
A caller-controlled state-root override can change that location and must be
trusted. Claude Code and Codex run as structured CLI processes. Selected
agent/skill instructions are bounded, provider-scoped data embedded in the
prompt; native Agent/Skill tools are disabled. Anthropic/OpenAI BYOK adapters
are non-streaming, response-bounded, text-only, reject provider tools/workspace
mutation, and may receive selected capability instructions only as prompt text.

Claude Code receives the narrower built-in tool allowlist plus safe mode and
MCP/Chrome isolation. Codex remains disabled by default; when explicitly
enabled it selects a provider-controlled `read-only` or `workspace-write`
sandbox. That limits a broad effect class and is not an exact command/tool
allowlist enforced by Super Router.

Policy-classified external and destructive plan nodes are unsupported for real
execution in 0.8. Category flags do not approve or enable them: the plan retains
a one-time human gate, and the scheduler then refuses the effect before checking
or invoking a provider. Critical local plans can proceed after their explicit
approval node. This gate is not syscall-level mediation inside a provider
runtime, whose sandbox remains a required control for supported local work.

`run` additionally fails closed until the caller supplies `--trust-project` (or
`trustProject: true` through the library). This acknowledges that a coding
runtime and allowlisted build/test commands can execute repository-controlled
code. It does not make that code safe or confine package scripts, compiler
plugins, or test configuration at the OS level. Do not grant trust to an
unreviewed checkout; use a disposable least-privilege OS sandbox when provenance
is uncertain.

`--provider <id>` is a hard provider constraint and removes cross-provider
fallback. `--prefer-provider <id>` is a soft preference and retains eligible
fallback. Neither option bypasses availability, capability, budget, quality,
risk, or permission checks.

`plan` is a structural preview. `run --dry-run --trust-project` enters the
scheduler with a simulation adapter, returns `simulated: true`, and invokes no
provider, verification command, approval callback, artifact effect, telemetry
write, or memory write. A dry-run is never accepted as verification evidence.

The token admission estimator is a conservative provider-neutral heuristic, not
an exact tokenizer. Anthropic/OpenAI receive provider-specific output-token
request fields. Claude/Codex receive an approximate output-budget instruction
and default to a 16 MiB child-process capture limit; that is a hard byte limit,
not a hard provider output-token limit.

Review nodes fail closed unless they return exactly one semantic PASS/FAIL
verdict, but the optimizer may route a reviewer to the same provider/model as
the author. Only a caller-supplied `independentReviewer` callback is a separate
review boundary, and the caller must make its implementation independent.

Local memory is a bounded linear JSONL store, not indexed/vector retrieval. The
default search/timeline scan is limited to 8 MiB/10,000 records; document,
retrieval, render, and telemetry-stat scans have separate documented caps and
report truncation. Project identity now includes the canonical local Git common
directory, so linked worktrees share state and independent clones do not. State
from the earlier remote-only namespace is not migrated automatically, and a
common-directory move or remote change can select another namespace; verify
provenance and back up both paths. A plain directory copy is insufficient
because records embed `projectId`; 0.8 has no migration command.

Known gaps include durable checkpoint recovery, cryptographically bound
approval tokens, executable pinning/signatures, a core network-domain sandbox,
enforced provider privacy/residency routing, effect-level provider mediation,
encrypted/tamper-evident local state, deletion/export and background retention
for idle state, an aggregate state-directory quota, automatic project-namespace
migration, live provider conformance, hard subscription output-token
enforcement, signed releases, and
an external security review. Telemetry retention is only opportunistic. Unix
process-group cancellation is stronger than the Windows direct-child signal.
Local CLI sandboxes and upstream data handling remain provider-controlled.

Run untrusted work in an OS-confined disposable environment with least-privilege
credentials, enable only installed providers reported healthy by
`super-router doctor`, and review every proposed external action. Disable memory
with `--no-memory` when local persistence is inappropriate.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for trust boundaries, known
gaps, and required controls.
