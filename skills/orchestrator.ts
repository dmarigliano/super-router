/**
 * Orchestrator - Coordinates execution of routed model/agent/skill chain
 */

import { PromptClassifier, type ClassificationResult } from "./classifier.ts";
import { AgentRouter, type AgentRoute } from "./agent-router.ts";
import { SkillRouter, type SkillRoute } from "./skill-router.ts";

export interface ModelRoute {
  model: string;
  reason: string;
}

export interface OrchestrationPlan {
  classification: ClassificationResult;
  model: ModelRoute;
  agents: AgentRoute;
  skills: SkillRoute;
  executionStrategy: ExecutionStrategy;
}

export type ExecutionStrategy = "sequential" | "parallel-agents" | "parallel-skills" | "hybrid";

const MODEL_THRESHOLDS = {
  HAIKU_MAX_TOKENS: 2000,
  SONNET_MAX_TOKENS: 20000,
  OPUS_MIN_TOKENS: 20000,
};

export class Orchestrator {
  private classifier = new PromptClassifier();
  private agentRouter = new AgentRouter();
  private skillRouter = new SkillRouter();

  /**
   * Analyze user request and create orchestration plan
   */
  async plan(userPrompt: string, context?: { currentModel?: string }): Promise<OrchestrationPlan> {
    // Classify the prompt
    const classification = this.classifier.classify(userPrompt);

    // Route to model
    const model = this.routeModel(classification, userPrompt, context);

    // Route to agents
    const agents = this.agentRouter.route(classification);

    // Route to skills
    const skills = this.skillRouter.route(classification, userPrompt);

    // Determine execution strategy
    const executionStrategy = this.determineExecutionStrategy(
      classification,
      agents,
      skills
    );

    return {
      classification,
      model,
      agents,
      skills,
      executionStrategy,
    };
  }

  /**
   * Route to optimal model based on complexity and cost
   */
  private routeModel(
    classification: ClassificationResult,
    prompt: string,
    context?: { currentModel?: string }
  ): ModelRoute {
    const estimatedTokens = prompt.length * 0.75; // rough estimate

    // Security/critical always use Opus
    if (classification.complexity === "CRITICAL") {
      return {
        model: "claude-opus-4-8",
        reason: "Critical complexity (security/architecture)",
      };
    }

    // Extended thinking needs Fable
    if (
      classification.intent === "design" ||
      classification.intent === "research" ||
      prompt.includes("plan")
    ) {
      return {
        model: "claude-fable-5",
        reason: "Extended thinking required for planning/research",
      };
    }

    // Simple tasks use Haiku
    if (
      classification.complexity === "LOW" &&
      estimatedTokens < MODEL_THRESHOLDS.HAIKU_MAX_TOKENS
    ) {
      return {
        model: "claude-haiku-4-5",
        reason: "Low complexity, fast task",
      };
    }

    // High complexity uses Opus
    if (
      classification.complexity === "HIGH" ||
      estimatedTokens > MODEL_THRESHOLDS.OPUS_MIN_TOKENS
    ) {
      return {
        model: "claude-opus-4-8",
        reason: "High complexity or large context",
      };
    }

    // Default to Sonnet 4.5
    return {
      model: "claude-sonnet-4-5",
      reason: "Standard coding task (balanced)",
    };
  }

  /**
   * Determine execution strategy
   */
  private determineExecutionStrategy(
    classification: ClassificationResult,
    agents: AgentRoute,
    skills: SkillRoute
  ): ExecutionStrategy {
    // High complexity with multiple agents and skills = hybrid
    if (
      classification.complexity === "HIGH" &&
      agents.agents.length > 2 &&
      skills.skills.length > 2
    ) {
      return "hybrid";
    }

    // Parallel agents if multiple independent agents
    if (agents.parallel && agents.agents.length > 2) {
      return "parallel-agents";
    }

    // Parallel skills if independent skills
    if (skills.sequence === "parallel" && skills.skills.length > 2) {
      return "parallel-skills";
    }

    // Default sequential
    return "sequential";
  }

  /**
   * Execute the orchestration plan
   * NOTE: This is a planning function - actual execution happens via Agent/Skill tools
   */
  async execute(plan: OrchestrationPlan): Promise<ExecutionResult> {
    const steps: ExecutionStep[] = [];

    // Step 1: Model selection (informational)
    steps.push({
      type: "model-selection",
      description: `Using ${plan.model.model}: ${plan.model.reason}`,
      status: "planned",
    });

    // Step 2: Agent execution
    if (plan.agents.agents.length > 0) {
      if (plan.agents.parallel) {
        steps.push({
          type: "parallel-agents",
          description: `Execute ${plan.agents.agents.length} agents in parallel`,
          agents: plan.agents.agents,
          status: "planned",
        });
      } else {
        for (const agent of plan.agents.agents) {
          steps.push({
            type: "agent",
            description: `Execute agent: ${agent}`,
            agent,
            status: "planned",
          });
        }
      }
    }

    // Step 3: Skill execution
    if (plan.skills.skills.length > 0) {
      if (plan.skills.sequence === "parallel") {
        steps.push({
          type: "parallel-skills",
          description: `Execute ${plan.skills.skills.length} skills in parallel`,
          skills: plan.skills.skills,
          status: "planned",
        });
      } else {
        for (const skill of plan.skills.skills) {
          steps.push({
            type: "skill",
            description: `Execute skill: ${skill}`,
            skill,
            status: "planned",
          });
        }
      }
    }

    return {
      plan,
      steps,
      summary: this.generateSummary(plan, steps),
    };
  }

  private generateSummary(plan: OrchestrationPlan, steps: ExecutionStep[]): string {
    const lines = [
      `## Super Router Execution Plan`,
      ``,
      `**Classification:**`,
      `- Intent: ${plan.classification.intent}`,
      `- Complexity: ${plan.classification.complexity}`,
      `- Domains: ${plan.classification.domain.join(", ")}`,
      `- Confidence: ${(plan.classification.confidence * 100).toFixed(0)}%`,
      ``,
      `**Model:** ${plan.model.model}`,
      `- Reason: ${plan.model.reason}`,
      ``,
      `**Agents (${plan.agents.agents.length}):** ${plan.agents.agents.join(", ")}`,
      `- Execution: ${plan.agents.parallel ? "Parallel" : "Sequential"}`,
      ``,
      `**Skills (${plan.skills.skills.length}):** ${plan.skills.skills.join(", ")}`,
      `- Sequence: ${plan.skills.sequence}`,
      ``,
      `**Strategy:** ${plan.executionStrategy}`,
      ``,
      `**Steps (${steps.length}):**`,
      ...steps.map((s, i) => `${i + 1}. ${s.description}`),
    ];

    return lines.join("\n");
  }
}

interface ExecutionStep {
  type: "model-selection" | "agent" | "skill" | "parallel-agents" | "parallel-skills";
  description: string;
  status: "planned" | "running" | "completed" | "failed";
  agent?: string;
  agents?: string[];
  skill?: string;
  skills?: string[];
}

interface ExecutionResult {
  plan: OrchestrationPlan;
  steps: ExecutionStep[];
  summary: string;
}
