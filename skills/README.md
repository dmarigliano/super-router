# Super Router

Intelligent orchestration system that automatically routes requests to optimal models, agents, and skills based on prompt analysis.

## Features

- **Automatic Model Selection**: Routes to Haiku/Sonnet/Opus/Fable based on complexity
- **Agent Routing**: Selects optimal agents from 67+ available agents
- **Skill Routing**: Maps to relevant skills from 367+ available skills
- **Cost Optimization**: Tracks savings from intelligent model selection
- **Parallel Execution**: Spawns independent agents/skills in parallel
- **Performance Monitoring**: Logs routing decisions and metrics

## Installation

Skill is auto-loaded in `~/.claude/skills/super-router/`.

## Usage

### Automatic (Default)

Just ask. Super Router analyzes and routes automatically:

```bash
# User types naturally:
"Add OAuth2 authentication to the API"

# Super Router automatically:
# 1. Classifies: implement, HIGH complexity, security domain
# 2. Selects model: Opus 4.8 (security-critical)
# 3. Routes agents: architect, security-reviewer, code-reviewer
# 4. Invokes skills: feature-dev, security-scan, code-review
# 5. Executes coordinated workflow
```

### Manual Override

```bash
/super-router --model opus "complex refactoring"
/super-router --agent security-reviewer "check auth code"
/super-router --skill tdd "implement with tests first"
```

### CLI Tool

```bash
# Analyze a task
bun ~/.claude/skills/super-router/index.ts "Add caching to API"

# View statistics
bun ~/.claude/skills/super-router/index.ts --stats

# View cost savings
bun ~/.claude/skills/super-router/index.ts --savings
```

## Architecture

```
User Request
    ↓
Prompt Classifier (extracts intent, complexity, domain)
    ↓
Model Router (Haiku/Sonnet/Opus/Fable)
    ↓
Agent Router (67 agents available)
    ↓
Skill Router (367 skills available)
    ↓
Orchestrator (coordinates execution)
```

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
    "preferSpeed": false,
    "preferQuality": true
  }
}
```

## Logs

- Routing decisions: `~/.claude/super-router.log`
- Cost savings: `~/.claude/super-router-savings.jsonl`

## Examples

### Bug Fix
```
"Fix login timeout issue"
→ Model: Sonnet 4.5
→ Agents: systematic-debugging
→ Skills: systematic-debugging, test-driven-development
```

### New Feature
```
"Add real-time notifications"
→ Model: Opus 4.8
→ Agents: architect, planner, code-reviewer
→ Skills: brainstorming, feature-dev, test-driven-development
```

### Security Audit
```
"Audit authentication code"
→ Model: Opus 4.8
→ Agents: security-reviewer, code-reviewer
→ Skills: security-scan, code-review
```

## See Also

- [SKILL.md](./SKILL.md) - Full skill documentation
- [auto-router](../auto-router/) - Model routing only
- `/cost-report` - View token usage and costs
