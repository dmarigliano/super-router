## Outcome

<!-- What user or maintainer outcome does this pull request deliver? -->

## Changes

<!-- Summarize the implementation. Keep architecture claims aligned with code and tests. -->

## Verification

<!-- List exact commands, tests, evals, and manual checks. -->

```text
bun install --frozen-lockfile
bun run check
bun audit --production
```

## Routing and economics

<!-- For routing changes: include baseline, quality floor, token/cost/latency effects, retries, and evaluation evidence. Otherwise write "Not applicable". -->

## Security and privacy

<!-- Describe changes to permissions, tools, providers, prompts, secrets, memory, telemetry, external effects, dependencies, or trust boundaries. -->

## Compatibility and migration

<!-- Note breaking contracts, configuration changes, provider/runtime requirements, and migration steps. -->

## Limitations and follow-up

<!-- State what remains incomplete or unverified. -->

## Checklist

- [ ] The change is focused and linked to an issue or clear problem statement.
- [ ] Tests or evaluation cases cover the behavior and important failures.
- [ ] `bun run check` passes locally.
- [ ] `bun audit --production` has no unresolved applicable vulnerability.
- [ ] Documentation and `CHANGELOG.md` reflect public behavior changes.
- [ ] Logs, fixtures, screenshots, and examples contain no secrets or private data.
- [ ] External/destructive actions and budget boundaries fail closed.
- [ ] I reviewed all AI-assisted changes and disclosed material assistance below.

## AI assistance

<!-- Describe material AI assistance, or write "None". The contributor remains responsible for the change. -->
