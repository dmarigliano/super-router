# Compatibility evidence

## Scope

This page records reproduced checks for the 0.8.0 source candidate. It is an
evidence snapshot, not a promise of universal compatibility, a provider
certification, or a performance/economics benchmark. Provider CLIs, model
identifiers, authentication, and subscription behavior can change independently
of Super Router.

## Local environment — 2026-08-01

| Component | Observed version or state | Evidence boundary |
| --- | --- | --- |
| Operating system | macOS 26.6 (25G72) | Only this local macOS host was used |
| Bun | 1.3.14 | Local build/test runtime |
| Node.js | 26.0.0 | Local binary/runtime check; not a claim about every supported Node release |
| Codex CLI | 0.146.0-alpha.9.2 | Authenticated through ChatGPT for the live check |
| Claude Code | 2.1.220 | Executable detected, but the account was not authenticated; no live Claude run was performed |

The package had not been published to npm when this snapshot was written. The
final candidate was packed locally, installed with lifecycle scripts disabled
into a disposable prefix, and exercised through its installed binary. Version,
library import, and managed Codex/Claude integration install/uninstall checks
passed. Hosted CI and CodeQL subsequently passed on the public merge commit. A
clean installation from the eventual registry artifact remains a release gate.

## Hosted repository verification — 2026-08-02

- The candidate was reconciled on top of the two preserved prototype commits
  without force-push and merged through [PR #1](https://github.com/dmarigliano/super-router/pull/1).
- The public `main` commit
  [`b056193`](https://github.com/dmarigliano/super-router/commit/b0561930bba4b0ff21b0f398c9aeb025234357e1)
  passed hosted [CI](https://github.com/dmarigliano/super-router/actions/runs/30730972945)
  and [CodeQL](https://github.com/dmarigliano/super-router/actions/runs/30730972926).
- The hosted CodeQL snapshot reported zero open alerts after the five findings
  detected on the candidate were fixed before merge.

These checks demonstrate reproducibility and static-analysis status for that
specific commit. They do not establish live provider compatibility, production
reliability, or a token-economy advantage.

## Reproduced Codex path

The following boundaries were exercised locally:

1. A direct ephemeral, read-only Codex invocation using `gpt-5.6-sol` completed
   through the existing ChatGPT-authenticated session.
2. `super-router doctor` reported the explicit Codex configuration healthy and
   authenticated.
3. A real run through the binary installed from the local 0.8.0 tarball routed
   a bounded repository-reading objective to Codex with `--provider codex`,
   `--model gpt-5.6-sol`, `--effort economy`, `--no-memory`, and the provider's
   read-only sandbox. It reached `verified`, passed all three step checks and
   task-level acceptance, and returned the package name from `package.json`.

This demonstrates that this specific adapter/runtime/account/model combination
worked once on the stated host. It does not establish compatibility with other
Codex releases, models, operating systems, account plans, repositories, or
future provider behavior.

## Token-accounting observation

The live Super Router/Codex run reported:

| Measure | Tokens |
| --- | ---: |
| Input | 72,849 |
| Cached input | 59,392 |
| Output | 875 |
| Reasoning | 96 |
| Super Router pre-run input estimate | 446 |

The provider-reported input was therefore far above the router's pre-run input
estimate. Cached input and provider/runtime overhead make these fields
non-equivalent, but the gap is operationally important: the integration path
worked, while token estimation and economic calibration were not validated.
The subscription route's zero incremental price in the local catalog is an
accounting convention, not evidence that the subscription or execution was
free.

This was one small functional objective with an existing authenticated session,
not a controlled benchmark. It provides no basis for a token-savings, cost,
quality, latency, or model-superiority claim. Those claims require repeated
accepted-task evaluations against versioned baselines, provider-reported usage,
and a documented treatment of cached tokens, orchestration overhead, retries,
and failures.

The final packed-candidate conformance run provided a second observation:

| Measure | Tokens |
| --- | ---: |
| Input | 84,094 |
| Cached input | 69,120 |
| Output | 527 |
| Reasoning | 14 |
| Sum of the three plan-node pre-run input estimates | 1,469 |

The installed binary completed in about 29.5 seconds with all three nodes and
task acceptance verified. This again validates the functional path, not the
router's token estimate or an economic advantage.

## Still unverified

- A live authenticated Claude Code execution through Super Router.
- Windows and Linux provider-runtime conformance.
- Clean installation from the final npm-registry artifact; only the locally
  packed candidate was installed and tested here.
- Marketplace installation from a public repository/tag.
- BYOK conformance against live Anthropic or OpenAI accounts.
- Load, soak, interruption/recovery, and cross-version compatibility.

Run `super-router doctor` in the actual target environment and start with
`plan` or `run --dry-run`. Keep provider sandboxes and approval controls enabled,
and verify current provider terms before using an authenticated subscription.
