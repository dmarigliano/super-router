# Native integrations

Super Router ships skills-only native bundles for Codex and Claude Code. They call the
`super-router` executable already present on `PATH`; they do not bundle another runtime, install a
provider, authenticate an account, or copy credentials.

## Safe local installer

From the published package, install both integrations for the current user:

```bash
super-router integrations install --all --scope user
```

From a source checkout, replace the prefix with
`node scripts/install-integrations.mjs`, followed by the same arguments.

Preview first with `--dry-run`. To install in one trusted repository, use an explicit root:

```bash
super-router integrations install --all --scope project --project-dir /absolute/repo
```

Remove only installer-managed files:

```bash
super-router integrations uninstall --all --scope user
```

The installer is idempotent and records hashes in a local ownership marker. It refuses symlink
targets, unmanaged collisions, and modified managed files. `--force` replaces or removes only the
fixed managed paths after an explicit request; unrelated files remain untouched. Its source
allowlist contains only plugin manifests, `SKILL.md`, `agents/openai.yaml`, and the small invocation
wrapper. It never scans or copies `.env`, provider configuration, credentials, memory, or telemetry.

## Codex

The distributable bundle is under `integrations/codex/` and uses
`.codex-plugin/plugin.json`. The repository marketplace lives at
`.agents/plugins/marketplace.json`. After the public repository and tag exist, add the marketplace:

```text
codex plugin marketplace add dmarigliano/super-router --ref v0.8.0
```

Open `/plugins`, inspect the bundle, install it, and start a new session. Invoke the skill as
`$super-router`. A direct user installation instead places the standalone skill at
`~/.agents/skills/super-router/`, an official Codex discovery location.

The direct installer places a standalone skill at `~/.agents/skills/super-router/`. The Codex skill
disables implicit invocation in `agents/openai.yaml`. Planning is the default; execution must be
explicit.

## Claude Code

The distributable bundle is under `integrations/claude-code/` and uses
`.claude-plugin/plugin.json`. The repository is also a Claude marketplace through
`.claude-plugin/marketplace.json`. After the repository is public:

```text
/plugin marketplace add dmarigliano/super-router
/plugin install super-router@super-router
/reload-plugins
```

Invoke `/super-router:route plan <objective>`, `/super-router:route dry-run <objective>`, or
`/super-router:route run <objective>`. The plugin skill has `disable-model-invocation: true`, so
Claude cannot select it automatically.

The direct installer intentionally uses the separate standalone payload and writes
`~/.claude/skills/super-router/SKILL.md` plus its invocation wrapper. Invoke that form as
`/super-router`. It does not copy the marketplace plugin layout into the standalone skills scanner.

## Execution boundary

Both bundles invoke a fixed Node wrapper with `shell: false`. The wrapper accepts exactly one
objective argument, bounds it to 100,000 characters, and always adds `--trust-project` to `run` and
`dry-run`. It never adds external-write or destructive flags. The objective must still be passed as
one safely quoted argument by the host agent.

The wrapper inherits the current process environment because provider CLIs and BYOK adapters may
need their existing authentication. It does not read, persist, print, or copy credentials itself.
Provider egress, subscription terms, Super Router configuration, and human approval gates still
apply. A plugin installation alone does not prove provider authentication or readiness; run
`super-router doctor`.

## Official references

- [OpenAI: build Codex skills](https://developers.openai.com/codex/skills)
- [OpenAI: package plugins](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: browse and install plugins](https://developers.openai.com/codex/plugins)
- [Anthropic: create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Anthropic: Claude Code skills](https://code.claude.com/docs/en/slash-commands)
- [Anthropic: distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
