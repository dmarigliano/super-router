---
name: super-router
description: Intelligent orchestration system that automatically routes requests to optimal models, agents, and skills based on prompt analysis. Zero user configuration needed.
metadata:
  origin: Custom
  version: 1.0.0
---

# Super Router - Autonomous AI Orchestration

Automatic routing of tasks to optimal models, agents, and skills without user intervention.

## Architecture

```
User Request
    ↓
┌─────────────────────────┐
│  Prompt Classifier      │
│  - Intent extraction    │
│  - Complexity analysis  │
│  - Domain detection     │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Model Router           │
│  Haiku/Sonnet/Opus/Fable│
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Agent Router           │
│  67 agents available    │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Skill Router           │
│  ~367 skills available  │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  Orchestrator           │
│  Coordinates execution  │
└─────────────────────────┘
```

## Routing Logic

### 1. Prompt Classification

Extracts from user request:
- **Intent**: what user wants (implement/fix/review/research/design)
- **Complexity**: LOW/MEDIUM/HIGH/CRITICAL
- **Domain**: language/framework/infra/security/performance
- **Scope**: single-file/multi-file/architecture/system
- **Time sensitivity**: urgent/normal/can-wait

### 2. Model Selection

Based on auto-router logic:
- **Haiku**: Simple, fast tasks (format/lint/docs)
- **Sonnet 4.5**: Standard coding (default)
- **Sonnet 5**: Latest capabilities
- **Opus 4.8**: Complex architecture/security
- **Fable 5**: Extended reasoning/planning

### 3. Agent Selection

Maps domain to agents:
```
Security → security-reviewer
TypeScript code → typescript-reviewer
Build errors → build-error-resolver
Architecture → architect
Planning → planner
Python → python-reviewer
Go → go-reviewer
Rust → rust-reviewer
Testing → tdd-guide
Performance → performance-optimizer
```

### 4. Skill Selection

Maps intent to skills:
```
"fix bug" → systematic-debugging
"implement feature" → feature-dev, test-driven-development
"review code" → code-review
"plan" → brainstorming, writing-plans
"commit" → prp-commit
"create PR" → prp-pr
"security audit" → security-scan
"refactor" → refactor-clean
```

## Decision Tree

```
User: "Add OAuth2 to API"
  ↓
Classifier:
  Intent: implement
  Complexity: HIGH
  Domain: security, architecture
  Scope: multi-file
  ↓
Model Router: Opus 4.8 (security-critical)
  ↓
Agent Router: architect → security-reviewer → code-reviewer
  ↓
Skill Router: feature-dev → security-scan → code-review
  ↓
Orchestrator: Execute chain
```

## Usage

### Automatic (Default)
Just ask. Router analyzes and routes automatically.

```bash
# User just types:
"Add caching to the API"

# Super Router automatically:
# 1. Classifies as: implement, medium complexity, performance domain
# 2. Selects: Sonnet 4.5 (balanced)
# 3. Routes to: architect → feature-dev agents
# 4. Invokes: feature-dev, performance-optimizer skills
# 5. Executes coordinated workflow
```

### Manual Override
Force specific routing:

```bash
/super-router --model opus "complex refactoring"
/super-router --agent security-reviewer "check this code"
/super-router --skill tdd "implement feature with tests first"
```

## Configuration

`~/.claude/skills/super-router/config.json`:

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
    "preferQuality": true,
    "autoEscalate": true
  },
  "thresholds": {
    "complexityHigh": 0.7,
    "complexityCritical": 0.9,
    "parallelAgentMax": 3
  },
  "logging": {
    "enabled": true,
    "path": "~/.claude/super-router.log",
    "trackSavings": true
  }
}
```

## Routing Rules

### Model Routing (from auto-router)
- Haiku: tokens < 2k, simple tasks
- Sonnet: 2k-20k tokens, standard coding
- Opus: > 20k tokens, complex/critical
- Fable: multi-step planning, deep reasoning

### Agent Routing
- **Code changes**: language-specific reviewer (typescript-reviewer, python-reviewer, etc)
- **Build failures**: build-error-resolver
- **Security code**: security-reviewer
- **Architecture**: architect
- **Planning**: planner
- **Testing**: tdd-guide
- **Performance**: performance-optimizer
- **Refactoring**: refactor-cleaner, code-simplifier

### Skill Routing
- **"fix bug"**: systematic-debugging
- **"implement"**: feature-dev, test-driven-development
- **"review"**: code-review
- **"plan"**: brainstorming, writing-plans
- **"commit"**: prp-commit
- **"PR"**: prp-pr
- **"security"**: security-scan
- **"refactor"**: refactor-clean
- **"test"**: test-driven-development
- **"document"**: update-docs

## Parallel Execution

Router spawns independent agents in parallel:

```javascript
// Example: parallel review
parallel([
  agent('security-reviewer', 'audit auth code'),
  agent('typescript-reviewer', 'check type safety'),
  agent('performance-optimizer', 'check query performance')
]);
```

## Cost Tracking

Logs to `~/.claude/super-router-savings.jsonl`:
```json
{
  "timestamp": "2026-07-25T10:00:00Z",
  "task": "Add OAuth2",
  "model": "opus",
  "agents": ["architect", "security-reviewer"],
  "skills": ["feature-dev", "security-scan"],
  "estimatedSavings": 0.35,
  "executionTime": 45.2
}
```

View savings:
```bash
/cost-report
```

## Monitoring

Real-time routing decisions:
```bash
tail -f ~/.claude/super-router.log
```

Example log:
```
2026-07-25 10:15:32 | Task: "Add auth" | Intent: implement | Complexity: HIGH | Model: opus | Agents: architect,security-reviewer | Skills: feature-dev,security-scan
```

## Advanced Features

### Context-Aware Routing
- Learns from previous routing decisions
- Adapts to user preferences over time
- Considers token budget remaining
- Adjusts for time constraints

### Escalation Strategy
- Start with lower-cost option
- Auto-escalate on failure
- Track escalation patterns
- Optimize routing over time

### Dependency Resolution
- Detects task dependencies
- Orders execution correctly
- Parallelizes independent work
- Sequences dependent steps

## Integration

### With ECC Workflows
Super Router integrates with ECC development workflow:

1. Research & Reuse (GitHub search, docs)
2. Super Router → Plan (planner agent + brainstorming skill)
3. Super Router → TDD (tdd-guide agent + test-driven-development skill)
4. Super Router → Implement (feature-dev skill)
5. Super Router → Review (code-reviewer agent + code-review skill)
6. Super Router → Commit (prp-commit skill)

### With Hooks
Can be triggered via hooks:

```json
{
  "hooks": {
    "pre-commit": "super-router --skill security-scan",
    "pre-push": "super-router --skill code-review"
  }
}
```

## Examples

### Example 1: Bug Fix
```
User: "Fix the login timeout issue"

Super Router:
  Classifier: fix, medium, security domain
  Model: Sonnet 4.5
  Agents: [systematic-debugging]
  Skills: [systematic-debugging, test-driven-development]
  
Execution:
  1. Systematic debugging to find root cause
  2. TDD to write failing test
  3. Implement fix
  4. Verify test passes
```

### Example 2: New Feature
```
User: "Add real-time notifications"

Super Router:
  Classifier: implement, high, architecture
  Model: Opus 4.8
  Agents: [architect, planner, code-reviewer]
  Skills: [brainstorming, feature-dev, test-driven-development, code-review]
  
Execution:
  1. Architect designs system
  2. Planner breaks down tasks
  3. Feature-dev implements with TDD
  4. Code-reviewer audits quality
```

### Example 3: Security Audit
```
User: "Audit authentication code"

Super Router:
  Classifier: review, critical, security
  Model: Opus 4.8
  Agents: [security-reviewer, code-reviewer]
  Skills: [security-scan, code-review]
  
Execution:
  1. Security-reviewer checks vulnerabilities
  2. Security-scan tool analysis
  3. Code-reviewer checks implementation
  4. Generate security report
```

## Override Rules

User can override at any level:

```bash
# Override model only
/model opus "use opus for this task"

# Override agent only
/agent security-reviewer "review this code"

# Override skill only
/skill tdd "use TDD for implementation"

# Override everything
/super-router --model opus --agent architect --skill feature-dev "build this feature"
```

## Best Practices

1. ✅ **Trust the router** - Let it optimize automatically
2. ✅ **Review logs** - Check routing decisions monthly
3. ✅ **Tune config** - Adjust thresholds for your workflow
4. ✅ **Override sparingly** - Only when you know better
5. ❌ **Don't micro-manage** - Router learns from usage
6. ❌ **Don't force Opus** - Costs 3x Sonnet

## Performance Metrics

Router tracks:
- Routing accuracy (was right model/agent/skill chosen?)
- Cost efficiency (savings vs manual selection)
- Task completion time
- Escalation frequency
- User override rate

## See Also

- `/auto-router` - Model routing only
- `/model-route` - ECC model routing skill
- `/cost-report` - Token usage and costs
- `/agent` - Manual agent invocation
- `/skill` - Manual skill invocation
