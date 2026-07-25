# Super Router

> Intelligent orchestration that automatically routes AI requests to optimal models, agents, and skills. Zero configuration needed.

## What It Does

Super Router analyzes your request and automatically:
- **Selects the best model** (Haiku/Sonnet/Opus/Fable) based on complexity
- **Routes to optimal agents** from 67+ available agents
- **Invokes relevant skills** from 367+ available skills
- **Executes in parallel** when tasks are independent
- **Tracks cost savings** vs always using Opus

## Installation

### Quick Install

```bash
# Unix/Linux/macOS
curl -fsSL https://raw.githubusercontent.com/yourusername/super-router/main/install.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/yourusername/super-router/main/install.ps1 | iex
```

### From Source

```bash
git clone https://github.com/yourusername/super-router.git
cd super-router
node bin/install.js
```

### Via NPM

```bash
npx super-router
```

## Usage

### Automatic (Recommended)

Just type your request naturally. Super Router handles everything:

```
"Add caching to the API"
→ Auto-selects: Sonnet 4.5
→ Auto-routes agents: architect, performance-optimizer
→ Auto-invokes skills: feature-dev, test-driven-development
→ Saves $12 vs Opus
```

### Manual Override

```bash
# Force specific model
/super-router --model opus "complex refactoring"

# Force specific agent
/super-router --agent security-reviewer "audit auth code"

# Force specific skill
/super-router --skill tdd "implement feature"
```

### CLI Tool

```bash
# Analyze a task
~/.bun/bin/bun ~/.claude/skills/super-router/index.ts "Add auth"

# View routing statistics
~/.bun/bin/bun ~/.claude/skills/super-router/index.ts --stats

# View cost savings
~/.bun/bin/bun ~/.claude/skills/super-router/index.ts --savings
```

## Examples

### Bug Fix
```
"Fix login timeout issue"
→ Sonnet 4.5 (balanced)
→ systematic-debugging agent
→ test-driven-development skill
```

### New Feature
```
"Add real-time notifications"
→ Opus 4.8 (complex architecture)
→ architect + planner + code-reviewer agents
→ brainstorming + feature-dev + TDD skills
```

### Security Audit
```
"Audit authentication code"
→ Opus 4.8 (security-critical)
→ security-reviewer + code-reviewer agents
→ security-scan + code-review skills
```

## Routing Logic

### Model Selection
- **Haiku**: Simple tasks, < 2k tokens (format/lint/docs)
- **Sonnet 4.5**: Standard coding, 2k-20k tokens (default)
- **Opus 4.8**: Complex/critical, > 20k tokens (architecture/security)
- **Fable 5**: Extended reasoning (planning/research)

### Agent Routing
Maps domain to specialized agents:
- Security → security-reviewer
- TypeScript → typescript-reviewer
- Python → python-reviewer
- Build errors → build-error-resolver
- Architecture → architect
- Testing → tdd-guide

### Skill Routing
Maps intent to workflow skills:
- "fix bug" → systematic-debugging
- "implement" → feature-dev + TDD
- "review" → code-review
- "plan" → brainstorming + writing-plans
- "security" → security-scan

## Configuration

Edit `~/.claude/skills/super-router/config.json`:

```json
{
  "routing": {
    "autoModel": true,
    "autoAgent": true,
    "autoSkill": true
  },
  "preferences": {
    "costOptimization": "balanced",
    "preferQuality": true
  }
}
```

## Cost Tracking

Super Router logs every decision and calculates savings:

```bash
# View total savings
~/.bun/bin/bun ~/.claude/skills/super-router/index.ts --savings
Total Cost Savings: $247.50
```

Logs stored at:
- `~/.claude/super-router.log` - Routing decisions
- `~/.claude/super-router-savings.jsonl` - Cost savings

## Uninstall

```bash
# Unix/Linux/macOS
node bin/install.js --uninstall

# Windows
node bin/install.js --uninstall

# Via NPM
npx super-router --uninstall
```

## Requirements

- Claude Code (any version)
- Node.js >= 18 or Bun >= 1.0
- 67+ agents available in `~/.claude/agents/`
- 367+ skills available via plugins

## License

MIT

## Contributing

Issues and PRs welcome at https://github.com/yourusername/super-router
