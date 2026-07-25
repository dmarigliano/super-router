/**
 * Logger - Track routing decisions and performance metrics
 */

import type { OrchestrationPlan } from "./orchestrator.ts";

export interface RoutingLog {
  timestamp: string;
  prompt: string;
  classification: {
    intent: string;
    complexity: string;
    domains: string[];
    confidence: number;
  };
  model: string;
  agents: string[];
  skills: string[];
  executionStrategy: string;
  executionTime?: number;
  success?: boolean;
  error?: string;
}

export interface CostSavings {
  timestamp: string;
  task: string;
  selectedModel: string;
  alternativeModel: string;
  estimatedSavings: number;
  reasoning: string;
}

export class Logger {
  private logPath = `${process.env.HOME}/.claude/super-router.log`;
  private savingsPath = `${process.env.HOME}/.claude/super-router-savings.jsonl`;

  /**
   * Log routing decision
   */
  async logRouting(prompt: string, plan: OrchestrationPlan): Promise<void> {
    const log: RoutingLog = {
      timestamp: new Date().toISOString(),
      prompt: prompt.slice(0, 200), // truncate long prompts
      classification: {
        intent: plan.classification.intent,
        complexity: plan.classification.complexity,
        domains: plan.classification.domain,
        confidence: plan.classification.confidence,
      },
      model: plan.model.model,
      agents: plan.agents.agents,
      skills: plan.skills.skills,
      executionStrategy: plan.executionStrategy,
    };

    await this.writeLog(log);
  }

  /**
   * Log execution result
   */
  async logResult(
    prompt: string,
    plan: OrchestrationPlan,
    executionTime: number,
    success: boolean,
    error?: string
  ): Promise<void> {
    const log: RoutingLog = {
      timestamp: new Date().toISOString(),
      prompt: prompt.slice(0, 200),
      classification: {
        intent: plan.classification.intent,
        complexity: plan.classification.complexity,
        domains: plan.classification.domain,
        confidence: plan.classification.confidence,
      },
      model: plan.model.model,
      agents: plan.agents.agents,
      skills: plan.skills.skills,
      executionStrategy: plan.executionStrategy,
      executionTime,
      success,
      error,
    };

    await this.writeLog(log);
  }

  /**
   * Log cost savings
   */
  async logSavings(savings: CostSavings): Promise<void> {
    try {
      const line = JSON.stringify(savings) + "\n";
      await Bun.write(this.savingsPath, line, { createPath: true });
    } catch (error) {
      console.error("Failed to log savings:", error);
    }
  }

  /**
   * Calculate estimated savings from model selection
   */
  calculateSavings(selectedModel: string, alternativeModel: string): number {
    const costs: Record<string, number> = {
      "claude-haiku-4-5": 0.25,
      "claude-sonnet-4-5": 3.0,
      "claude-sonnet-5": 3.0,
      "claude-opus-4-8": 15.0,
      "claude-fable-5": 6.0,
    };

    const selectedCost = costs[selectedModel] || 3.0;
    const alternativeCost = costs[alternativeModel] || 3.0;

    return Math.max(0, alternativeCost - selectedCost);
  }

  /**
   * Get routing statistics
   */
  async getStats(): Promise<RoutingStats> {
    try {
      const content = await Bun.file(this.logPath).text();
      const logs = content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RoutingLog);

      const totalRoutes = logs.length;
      const successRate =
        logs.filter((l) => l.success === true).length / totalRoutes;
      const avgExecutionTime =
        logs.reduce((sum, l) => sum + (l.executionTime || 0), 0) / totalRoutes;

      const modelUsage = logs.reduce(
        (acc, log) => {
          acc[log.model] = (acc[log.model] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      const complexityDistribution = logs.reduce(
        (acc, log) => {
          const complexity = log.classification.complexity;
          acc[complexity] = (acc[complexity] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      return {
        totalRoutes,
        successRate,
        avgExecutionTime,
        modelUsage,
        complexityDistribution,
      };
    } catch {
      return {
        totalRoutes: 0,
        successRate: 0,
        avgExecutionTime: 0,
        modelUsage: {},
        complexityDistribution: {},
      };
    }
  }

  /**
   * Get total cost savings
   */
  async getTotalSavings(): Promise<number> {
    try {
      const content = await Bun.file(this.savingsPath).text();
      const savings = content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as CostSavings);

      return savings.reduce((sum, s) => sum + s.estimatedSavings, 0);
    } catch {
      return 0;
    }
  }

  private async writeLog(log: RoutingLog): Promise<void> {
    try {
      const line = JSON.stringify(log) + "\n";
      await Bun.write(this.logPath, line, { createPath: true });
    } catch (error) {
      console.error("Failed to write log:", error);
    }
  }
}

interface RoutingStats {
  totalRoutes: number;
  successRate: number;
  avgExecutionTime: number;
  modelUsage: Record<string, number>;
  complexityDistribution: Record<string, number>;
}
