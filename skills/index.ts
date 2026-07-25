#!/usr/bin/env bun

/**
 * Super Router - Main entry point
 * Intelligent orchestration of models, agents, and skills
 */

import { Orchestrator } from "./orchestrator.ts";
import { Logger } from "./logger.ts";

const orchestrator = new Orchestrator();
const logger = new Logger();

async function main() {
  const args = process.argv.slice(2);

  // Handle special commands
  if (args[0] === "--stats") {
    const stats = await logger.getStats();
    console.log("Super Router Statistics:");
    console.log(`Total Routes: ${stats.totalRoutes}`);
    console.log(`Success Rate: ${(stats.successRate * 100).toFixed(1)}%`);
    console.log(`Avg Execution Time: ${stats.avgExecutionTime.toFixed(2)}s`);
    console.log("\nModel Usage:");
    for (const [model, count] of Object.entries(stats.modelUsage)) {
      console.log(`  ${model}: ${count}`);
    }
    console.log("\nComplexity Distribution:");
    for (const [complexity, count] of Object.entries(stats.complexityDistribution)) {
      console.log(`  ${complexity}: ${count}`);
    }
    return;
  }

  if (args[0] === "--savings") {
    const total = await logger.getTotalSavings();
    console.log(`Total Cost Savings: $${total.toFixed(2)}`);
    return;
  }

  // Parse user prompt
  const prompt = args.join(" ");
  if (!prompt) {
    console.error("Usage: super-router <task-description>");
    console.error("       super-router --stats");
    console.error("       super-router --savings");
    process.exit(1);
  }

  // Create orchestration plan
  const startTime = Date.now();
  const plan = await orchestrator.plan(prompt);

  // Log routing decision
  await logger.logRouting(prompt, plan);

  // Execute plan
  const result = await orchestrator.execute(plan);
  const executionTime = (Date.now() - startTime) / 1000;

  // Display plan
  console.log(result.summary);

  // Log result
  await logger.logResult(prompt, plan, executionTime, true);

  // Calculate and log savings
  const savings = logger.calculateSavings(
    plan.model.model,
    "claude-opus-4-8" // baseline comparison
  );

  if (savings > 0) {
    await logger.logSavings({
      timestamp: new Date().toISOString(),
      task: prompt.slice(0, 100),
      selectedModel: plan.model.model,
      alternativeModel: "claude-opus-4-8",
      estimatedSavings: savings,
      reasoning: plan.model.reason,
    });
    console.log(`\nEstimated Savings: $${savings.toFixed(2)} vs Opus`);
  }
}

main().catch((error) => {
  console.error("Super Router Error:", error);
  process.exit(1);
});
