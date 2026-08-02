import type { ExecutionContext, ProviderAdapter, ProviderExecutionResult } from "../contracts.ts";
import { emptyUsage, routeDescription } from "./shared.ts";

export class DryRunAdapter implements ProviderAdapter {
  readonly id = "dry-run";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(context: ExecutionContext): Promise<ProviderExecutionResult> {
    const route = routeDescription(context.route);
    return {
      output: [
        `[dry-run] Planned step: ${context.step.title}`,
        `Route: ${route}`,
        `Agent: ${context.route.agent ?? "coordinator"}`,
        `Skills: ${context.route.skills.join(", ") || "none"}`,
        `Tools: ${context.route.tools.join(", ") || "none"}`,
        "Verification: not executed in simulation mode",
      ].join("\n"),
      artifacts: [],
      usage: { ...emptyUsage(), costFinal: true },
      raw: { dryRun: true, stepId: context.step.id, route: context.route },
    };
  }
}
