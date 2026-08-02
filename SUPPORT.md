# Support

Super Router is a community-oriented open source **0.8 MVP**, maintained on a
best-effort basis. There is no guaranteed response or resolution time, hosted
control plane, or implied commercial service.

## Where to ask

| Need | Channel |
| --- | --- |
| Reproducible bug | [Bug report](https://github.com/dmarigliano/super-router/issues/new?template=bug_report.yml) |
| Feature or design proposal | [Feature request](https://github.com/dmarigliano/super-router/issues/new?template=feature_request.yml) |
| Security vulnerability | [Private security report](https://github.com/dmarigliano/super-router/security/advisories/new) |
| Usage question | Search existing issues, then open a bug report with `Request type: Support question` |

Do not put secrets, raw private prompts, API keys, customer data, or proprietary
source code in a public issue. Use a minimal synthetic reproduction.

## Useful diagnostic information

Include only non-sensitive information:

- Super Router version or commit.
- Operating system and architecture.
- Bun and Node.js versions.
- Command and sanitized configuration.
- Expected and actual behavior.
- Minimal reproduction.
- Sanitized error output.
- Whether the run was dry-run or execution mode.
- Provider type, but never credentials.

Please confirm the issue on the latest `main` source, or on the latest scoped
`@dmarigliano/super-router` release once one is published, when practical. The
unscoped npm package is unrelated to this repository.

## Project boundaries

The project can investigate routing, planning, budget, policy, adapter,
verification, telemetry, and memory behavior under its control. Provider
availability, account billing disputes, model behavior, third-party tools, and
local environment policies may need to be handled by the relevant vendor.

The existence of an architecture or roadmap item does not mean it is implemented
in 0.8. The current source and tests are authoritative.

Claude Code/Codex authentication, subscription limits, and sandbox behavior are
owned by those runtimes. Anthropic/OpenAI BYOK billing, retention, model access,
and rate limits are owned by the corresponding account/provider. Super Router
can investigate its adapter boundary but cannot resolve an upstream account or
billing issue.

## Commercial support

No commercial support program is offered by this repository at this time.
Community members may answer issues and review pull requests under the project
governance and Code of Conduct; no answer should request credentials or private
source in a public thread.
