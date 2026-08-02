# Provider configuration

## Supported strategy

Super Router keeps intake, planning, routing, scheduling, verification, and
memory provider-agnostic. Adapters are execution boundaries, not a source of
policy or authority.

The supported order of preference is:

1. **Claude Code or Codex subscription CLI** for repository-aware coding work.
2. **Anthropic or OpenAI BYOK HTTP** as an opt-in, metered fallback for an
   eligible text-only step.

Subscription accounting uses `billingMode: "subscription"`; the default model
catalog records zero incremental API price for those calls. This is a routing
convention, not a statement about the price or limits of a user's subscription.
BYOK adapters use the model prices configured by the user.

## Trusted configuration boundary

Provider catalogs select executables, HTTP endpoints, credential environment
names, model capabilities, and cost priors. A repository must not be able to
change those values merely by being opened.

For that reason:

- `./super-router.config.json` is treated as an untrusted project preference
  file. It cannot define `providers`, enable external/destructive actions, or
  enable raw-prompt persistence.
- A file selected with `--config` or `SUPER_ROUTER_CONFIG` is trusted and may
  define providers.
- The explicit external/destructive CLI flags record only an action category.
  A classified node still receives a human gate, and real 0.8 execution then
  stops before provider access because effect execution and receipt
  verification are not implemented.

Start with [`examples/providers.config.json`](../examples/providers.config.json).
Keep the working copy in a trusted user-controlled directory when possible,
enable only installed/authenticated adapters, and pass it explicitly:

```bash
export SUPER_ROUTER_CONFIG=/absolute/path/to/providers.config.json
bun run src/cli.ts doctor
bun run src/cli.ts capabilities
```

`--config` takes precedence over `SUPER_ROUTER_CONFIG`. Relative `--config`
paths resolve from `--cwd` (or the current working directory when `--cwd` is
omitted).

The canonical npm package name is `@dmarigliano/super-router`; it installs the
`super-router` command. The unscoped `super-router` npm package is unrelated.
The 0.8.0 source tree remains a release candidate until the scoped version is
verifiably published. Until then, run the CLI from a source checkout with
`bun run src/cli.ts`; after a real global installation, replace that prefix
with `super-router`.

## Subscription CLI adapters

### Claude Code

The built-in default enables `claude-code` with the `claude` executable. The
adapter starts an ephemeral print session, passes structured arguments without
an implicit shell, maps the selected effort and bounded tools, and relies on
Claude Code's authentication and permission controls.

### Codex

The Codex adapter runs `codex exec` as an ephemeral JSONL session and selects a
read-only or workspace-write sandbox from the step intent. It is disabled in
the built-in catalog because model identifiers and account availability can
vary. Add or update a trusted model catalog, enable `codex`, and run `doctor`
before routing work to it.

This sandbox is coarse and provider-controlled: `read-only` versus
`workspace-write` constrains an effect class, but the Codex CLI does not expose
an exact per-command/tool allowlist equivalent to the narrower Claude tool set.
Keep Codex disabled unless that boundary is acceptable for the workspace.

For either CLI, verify model aliases and capabilities against the installed
runtime. Catalog entries are operator assertions used by the optimizer; they
are not automatically certified benchmark results.

Selected Super Router agents and skills are not loaded through provider-native
registries. Their exact provider-scoped instructions are bounded and embedded
in the prompt; native Agent/Skill tools and ambient substitutions remain
disabled. Each CLI is asked to stay approximately within the step output-token
budget, while built-in process capture defaults to a hard 16 MiB cap. That byte
cap is not a hard provider output-token stop.

Super Router's approval is a plan-node gate, not complete mediation of every
filesystem, process, or network effect inside a vendor runtime. Keep the
runtime's sandbox and permission controls enabled and use least privilege.

## Native Codex and Claude Code entry points

The release candidate contains skills-only integration bundles under
`integrations/codex` and `integrations/claude-code`. These bundles call the
existing `super-router` executable; they do not install or authenticate Codex,
Claude Code, or an API provider. They also do not turn the router's selected
agents or skills into provider-native capabilities: those selections remain
bounded prompt material passed to the downstream adapter.

After a scoped package installation exists, preview installation before
writing user paths:

```bash
super-router integrations install --all --scope user --dry-run
super-router integrations install --all --scope user
```

Use `--codex` or `--claude-code` for one host, or project scope only with an
explicit `--project-dir /absolute/path`. The matching `uninstall` action
removes installer-managed files. From a reviewed source checkout, use the
equivalent `node scripts/install-integrations.mjs ...` entry point.

The native bundles inherit the host process environment so that an existing
provider session or BYOK variable can remain available to Super Router. The
installer itself does not scan or copy credentials, provider configuration,
memory, or telemetry. Installation therefore proves neither authentication
nor compatibility; run `super-router doctor` and follow the host provider's
own sandbox, permission, data-handling, and subscription terms.

Marketplace installation additionally depends on the repository being public
and the referenced release/tag existing. See
[`integrations/README.md`](../integrations/README.md) for the exact Codex and
Claude Code commands. The single reproduced live Codex check and the untested
Claude authentication boundary are recorded in
[`docs/COMPATIBILITY.md`](COMPATIBILITY.md); neither is a universal provider
certification.

## BYOK HTTP fallbacks

The direct adapters are disabled by default and deliberately narrow:

| Provider | Endpoint | Credential variable | Boundary |
| --- | --- | --- | --- |
| Anthropic | official Messages API | `ANTHROPIC_API_KEY` | Non-streaming text response |
| OpenAI | official Responses API with `store: false` | `OPENAI_API_KEY` | Non-streaming text response |

They reject every route containing a provider tool or workspace-mutation
requirement. A selected agent or skill can be accepted only when its bounded
instructions are materialized in the prompt; this is prompt context, not native
capability execution. The adapters do not edit the workspace, execute generated
commands, or claim that returned prose is a code artifact. This makes them
suitable for eligible planning, review, research, design, documentation, and
security-analysis stages whose route requires no local tool.

“Local-first” describes Super Router state, not model execution. Claude Code,
Codex, Anthropic, and OpenAI may transmit prompt/context to their upstream
services under their own settings and policies. `--no-memory` prevents Super
Router memory reads/writes; it does not block provider transmission or control
upstream retention. Provider privacy/residency is not yet an optimizer filter.

To opt in:

1. Export the key through the shell or a secret manager. Super Router does not
   parse `.env` files automatically.
2. Set the corresponding provider's `enabled` field to `true` in the trusted
   catalog.
3. Confirm the model identifier, context/output limits, prices, and effort
   support for the account. Set `sendEffort: false` if a selected model does not
   accept the mapped effort field.
4. Run `super-router doctor` before execution.

Do not put a key in `baseUrl`, JSON configuration, logs, issues, or prompts.
Custom base URLs must use HTTPS and cannot contain credentials.

## Model catalog fields

Every enabled provider needs an enabled model matching `defaultModel`. Each
model declares:

- supported task intents, efforts, tools, and domains;
- context and output ceilings;
- input/output (and optional cached-input) price per million tokens;
- an operator-supplied quality prior and latency prior.

The router's provider-neutral token estimate is a conservative
character/UTF-8 heuristic, not an exact provider tokenizer. Anthropic/OpenAI
map a step output budget to their output-token request fields; Claude/Codex use
the approximate instruction and byte-bounded transport described above.

Prices, model names, and capabilities drift. Treat the example as a
schema-valid starting point, not a live price feed. Recalibrate catalogs with
provider-reported usage and project evals before making savings claims.

## Provider overrides

`--provider <id>` is a hard requirement: it removes cross-provider fallback.
`--prefer-provider <id>` is a soft preference and keeps eligible fallback
providers. Both remain subject to availability, capability materialization,
quality, risk, budget, and permission checks.

## Fail-closed checklist

- Enable only providers that `super-router doctor` reports as available.
- Keep API providers disabled when no key is intentionally configured.
- Confirm that the selected provider is permitted to receive the task data;
  `--no-memory` alone is not a data-egress control.
- Keep coding tools on a sandboxed CLI route; do not add tools to a BYOK model
  merely to make it eligible.
- Review `super-router plan --explain` before a material run.
- Add `--trust-project` to every `run`, including `run --dry-run`. The flag
  acknowledges repository-controlled execution; it is not a sandbox. Dry-run
  itself uses a simulation adapter and writes neither telemetry nor memory.
- Treat external/destructive category flags as planning and simulation metadata,
  not permission to perform an effect. Real 0.8 runs refuse those nodes even
  after authorization and approval.
- Never report a provider response as accepted work unless verification passes.
