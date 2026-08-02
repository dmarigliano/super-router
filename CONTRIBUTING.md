# Contributing to Super Router

Thank you for helping improve Super Router. This is a community-oriented open
source project and currently an executable **0.8 MVP under active development**.
Interfaces may change before 1.0. Source, tests, release notes, and the
conservative status in [architecture](docs/ARCHITECTURE.md) take precedence
over proposals in the [roadmap](docs/ROADMAP.md).

## Ways to contribute

- Reproduce and reduce a bug.
- Add tests or evaluation cases, especially in Portuguese and English.
- Improve routing, cost, quality, or safety policies with measurable evidence.
- Add or harden a provider, agent, skill, or tool adapter behind a narrow
  interface and conformance tests.
- Improve documentation without overstating the implementation.
- Review security boundaries and failure modes.

For support questions, see [SUPPORT.md](SUPPORT.md). Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

## Before opening an issue

1. Search existing issues and pull requests.
2. Confirm the behavior on the latest `main` branch when practical.
3. Remove prompts, tokens, credentials, customer data, and proprietary code
   from logs and examples.
4. For a proposed feature, explain the user outcome, quality requirement, and
   expected token/cost trade-off.

## Development setup

Prerequisites:

- Bun 1.1 or newer.
- Node.js 20 or newer for packaged runtime compatibility.
- Git.

Install and validate:

```bash
bun install --frozen-lockfile
bun run check
bun audit --production
```

`bun run check` is the required local gate. It type-checks, lints, tests, and
builds the package. Do not update the lockfile incidentally; use a normal
`bun install` only when intentionally changing dependencies.

## Making a change

1. Create a focused branch from an up-to-date `main`.
2. Keep the patch scoped to one outcome.
3. Add or update tests for behavioral changes.
4. Update documentation and `CHANGELOG.md` when behavior, configuration, or a
   public contract changes.
5. Run the full local gates.
6. Open a pull request using the repository template.

Small, reviewable pull requests are preferred. Refactors should be separated
from behavioral changes unless separating them would make the change harder to
verify.

## Design expectations

Changes to routing and execution must preserve these invariants:

- A task is accepted only when its verification policy passes.
- Budgets are hard ceilings, not advisory targets.
- Critical local operations require their configured authorization gate. Real
  external/destructive effects remain unsupported in 0.8; future execution
  must retain a concrete human gate and add enforceable mediation plus receipts.
- Capabilities are selected from discovered, enabled capabilities; identifiers
  must not be invented at execution time.
- Untrusted prompt, memory, skill, tool, and provider output is data, not
  authority.
- The router should minimize total expected cost while meeting the requested
  quality and safety floor. A cheap failed attempt is still a cost.
- Durable memory stores verified, scoped facts rather than raw prompts by
  default.
- Project-local configuration cannot replace trusted provider catalogs or grant
  broader execution/data authority.
- Subscription CLI runtimes remain the preferred path for coding tools; BYOK
  HTTP adapters remain text-only unless a separately reviewed architecture and
  threat model prove a broader boundary.

For a new provider or capability adapter, document:

- Availability and authentication checks.
- Supported tools and effort levels.
- Token and cost accounting units.
- Timeouts, cancellation, retries, and rate limits.
- Permission and sandbox requirements.
- Redaction behavior.
- Deterministic test doubles or fixtures.
- Failure semantics and fallback eligibility.

Provider contributions must also declare one billing boundary (`subscription`
or `metered`) and one transport boundary (`cli` or `http`). Credentials belong
in the environment or an OS/vendor credential mechanism, never in committed
configuration. An HTTP adapter must not advertise tools, agents, skills, or
artifact mutation it cannot independently enforce and verify.

## Tests and evaluations

Unit tests should be deterministic and must not require paid credentials or
network access. Mark integration tests clearly and keep them opt-in.

Routing changes should include evaluation cases covering at least:

- The intended route and a plausible competing route.
- Quality-floor behavior.
- Budget exhaustion.
- Missing or unavailable capabilities.
- Prompt-injection and unsafe-action attempts when relevant.
- Portuguese and English prompts when language affects classification.

Do not claim savings based only on model list prices. Cost evidence should use
actual input, output, reasoning, and cached-token usage when the provider makes
those values available.

## Code style

- Use TypeScript with strict types at trust boundaries.
- Prefer explicit contracts and small modules.
- Avoid `any` at provider, tool, memory, and configuration boundaries.
- Validate external data before using it.
- Keep logs structured, bounded, and free of secrets.
- Prefer the platform or an existing dependency before adding new code or a
  new dependency.

The project uses Biome for formatting and linting. Run `bun run check` rather
than manually fixing generated output.

## Commits and pull requests

Use concise imperative commit messages. In the pull request, include:

- What problem is solved.
- What changed.
- How it was verified.
- Security, privacy, compatibility, and cost effects.
- Remaining limitations or follow-up work.

Pull requests need passing CI and review before merge. Maintainers may request
additional evaluation evidence for changes to routing, budgets, execution,
memory, permissions, or telemetry.

Maintainer attention is best-effort. Acceptance of an issue or pull request
does not promise a release date, hosted service, or commercial support. Durable
features should have more than one understandable implementation path so the
community can maintain them without a private control plane.

## AI-assisted contributions

AI-assisted work is welcome, but the contributor remains responsible for every
line and claim. Review generated changes, disclose material AI assistance in
the pull request, verify license compatibility, and never submit secrets or
third-party proprietary content.

## Community standards

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By
contributing, you agree that your contribution is licensed under the project's
[MIT License](LICENSE).
