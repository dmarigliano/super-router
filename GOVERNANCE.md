# Governance

Super Router is a community-oriented open source project in its pre-1.0 bootstrap phase. This
document describes how repository decisions are made today; it does not imply a foundation,
commercial support organization, or elected governing body.

## Roles

- **Contributors** report issues, propose designs, improve documentation, write code or tests, and
  participate in reviews. Anyone may become a contributor.
- **Reviewers** are contributors with relevant context who provide technical feedback. A review is
  advisory unless the reviewer is also a maintainer or a protected-branch rule requires it.
- **Maintainers** triage work, set repository direction, merge pull requests, manage releases and
  security reports, and enforce the Code of Conduct.

The current maintainer is:

| Maintainer | GitHub | Scope |
| --- | --- | --- |
| Daniel Marigliano | [@dmarigliano](https://github.com/dmarigliano) | Repository, releases, security, and community moderation |

Maintainer service is best-effort. The role does not create a support SLA or a commitment to accept
a contribution or publish a release.

## Decisions

Routine fixes and documentation changes are decided through pull-request review. Material changes
to public contracts, routing economics, provider execution, memory, telemetry, permissions, or
security boundaries should begin with an issue or design note that records the problem, alternatives,
compatibility impact, security impact, and verification evidence.

The project seeks rough consensus: concrete evidence and stated trade-offs matter more than vote
counts. During the bootstrap phase, the current maintainer makes the final repository decision when
consensus is unclear. Decisions that materially change architecture should be captured in the
architecture documentation or, once introduced, an architecture decision record.

The maintainer may merge an urgent security or build-recovery fix before normal public discussion.
The rationale and non-sensitive follow-up should be documented after the immediate risk is contained.

## Ownership and review

[`CODEOWNERS`](.github/CODEOWNERS) identifies the maintainer responsible for review; it is not a
claim that GitHub branch protection is already configured. Contributors remain responsible for the
changes they submit, including AI-assisted changes.

Every merge should have passing required checks and an intentional review of behavior, tests,
documentation, compatibility, security, privacy, and cost impact. While there is only one maintainer,
the maintainer may review and merge their own focused change after the full gate passes. High-risk
changes should receive independent review when a qualified reviewer is available, and must not be
described as independently reviewed when they have not received it.

Maintainer access follows least privilege. Credentials, npm publishing access, private security
reports, and repository administration must not be shared through issues, pull requests, or project
configuration.

## Releases during 0.x

There is no fixed release schedule. Before publishing an `0.x` release, the maintainer should:

1. choose the version and document user-visible changes and known limitations in `CHANGELOG.md`;
2. run the locked local/CI gate, dependency audit, package-content dry-run, and packaged Node smoke;
3. confirm that examples contain no credentials and that model identifiers/prices are presented as
   operator-maintained configuration rather than certified live data;
4. observe the required hosted CI and security checks on the release commit;
5. create the Git tag/release and publish only the scoped `@dmarigliano/super-router` package.

Until a release workflow, provenance, and signing are implemented, publication is a manual
maintainer operation. A source-tree version or changelog entry is not evidence that npm publication
occurred. Breaking changes may ship in a minor `0.x` release and must be called out explicitly.

Security releases follow `SECURITY.md`. A compromised or materially unsafe release may be deprecated
or withdrawn while a fixed version is prepared.

## Becoming or leaving a maintainer

Additional maintainers may be invited after sustained, constructive contributions and demonstrated
judgment across implementation, review, security, and community conduct. Existing maintainers decide
the invitation and record the resulting ownership change in this document and `CODEOWNERS`.

A maintainer may step down at any time. Access should be removed promptly, active security/release
work handed over privately, and the maintainer table updated. Inactivity alone does not silently
transfer publishing or security authority.

## Conflicts and conduct

Participants must follow `CODE_OF_CONDUCT.md`. A participant with a personal, financial, or other
material conflict should disclose it and recuse themselves from the affected decision where
practical. Security-sensitive details should be disclosed only through the private channel in
`SECURITY.md`.

Conduct reports involving the current maintainer have no fully independent project appeal path
during the single-maintainer bootstrap phase. Affected participants may use GitHub's platform
reporting mechanisms. Establishing a multi-maintainer, conflict-independent moderation path is a
future governance maturity goal, not a control claimed by version 0.8.
