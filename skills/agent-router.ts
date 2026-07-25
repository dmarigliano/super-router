/**
 * Agent Router - Maps task requirements to optimal agents
 */

import type { ClassificationResult, Domain, Intent, Complexity } from "./classifier.ts";

export interface AgentRoute {
  agents: string[];
  parallel: boolean;
  reason: string;
}

const DOMAIN_AGENTS: Record<string, string[]> = {
  typescript: ["typescript-reviewer", "react-reviewer"],
  javascript: ["typescript-reviewer"],
  python: ["python-reviewer", "django-reviewer", "fastapi-reviewer"],
  go: ["go-reviewer"],
  rust: ["rust-reviewer"],
  java: ["java-reviewer"],
  swift: ["swift-reviewer"],
  kotlin: ["kotlin-reviewer"],
  dart: ["dart-build-resolver", "flutter-reviewer"],
  php: ["php-reviewer"],
  ruby: ["python-reviewer"],
  csharp: ["csharp-reviewer"],
  cpp: ["cpp-reviewer"],
  react: ["react-reviewer", "typescript-reviewer"],
  vue: ["vue-reviewer", "typescript-reviewer"],
  angular: ["typescript-reviewer"],
  flutter: ["flutter-reviewer", "dart-build-resolver"],
  security: ["security-reviewer"],
  performance: ["performance-optimizer"],
  database: ["database-reviewer"],
  testing: ["tdd-guide", "e2e-runner"],
  architecture: ["architect", "planner"],
};

const INTENT_AGENTS: Record<Intent, string[]> = {
  implement: ["feature-dev:code-architect", "tdd-guide"],
  fix: ["general-purpose", "tdd-guide"],
  review: ["code-reviewer"],
  research: ["Explore"],
  design: ["architect", "planner"],
  refactor: ["refactor-cleaner", "code-simplifier"],
  test: ["tdd-guide", "e2e-runner"],
  document: ["doc-updater"],
  optimize: ["performance-optimizer"],
  "security-audit": ["security-reviewer", "code-reviewer"],
  debug: ["general-purpose"],
};

const COMPLEXITY_AGENTS: Record<Complexity, string[]> = {
  LOW: [],
  MEDIUM: ["code-reviewer"],
  HIGH: ["architect", "code-reviewer"],
  CRITICAL: ["architect", "security-reviewer", "code-reviewer"],
};

export class AgentRouter {
  route(classification: ClassificationResult): AgentRoute {
    const agents = new Set<string>();
    let parallel = false;

    // Add intent-based agents
    const intentAgents = INTENT_AGENTS[classification.intent] || [];
    intentAgents.forEach((a) => agents.add(a));

    // Add domain-based agents
    for (const domain of classification.domain) {
      const domainAgents = DOMAIN_AGENTS[domain] || [];
      domainAgents.forEach((a) => agents.add(a));
    }

    // Add complexity-based agents
    const complexityAgents = COMPLEXITY_AGENTS[classification.complexity] || [];
    complexityAgents.forEach((a) => agents.add(a));

    // Determine if parallel execution makes sense
    if (agents.size > 2 && classification.complexity !== "LOW") {
      parallel = true;
    }

    // Build routing reason
    const reason = this.buildReason(classification, Array.from(agents), parallel);

    return {
      agents: this.prioritizeAgents(Array.from(agents), classification),
      parallel,
      reason,
    };
  }

  private prioritizeAgents(agents: string[], classification: ClassificationResult): string[] {
    const priority: Record<string, number> = {
      architect: 1,
      planner: 2,
      "security-reviewer": 3,
      "feature-dev:code-architect": 4,
      "tdd-guide": 5,
      "code-reviewer": 10,
    };

    return agents.sort((a, b) => {
      const priorityA = priority[a] || 99;
      const priorityB = priority[b] || 99;
      return priorityA - priorityB;
    });
  }

  private buildReason(
    classification: ClassificationResult,
    agents: string[],
    parallel: boolean
  ): string {
    const parts = [
      `Intent: ${classification.intent}`,
      `Complexity: ${classification.complexity}`,
      `Domains: ${classification.domain.join(", ")}`,
      `Agents: ${agents.join(", ")}`,
      `Execution: ${parallel ? "parallel" : "sequential"}`,
    ];

    return parts.join(" | ");
  }

  /**
   * Get agent for specific build errors
   */
  routeBuildError(framework: string): string {
    const buildResolvers: Record<string, string> = {
      typescript: "build-error-resolver",
      react: "react-build-resolver",
      python: "python-reviewer",
      go: "go-build-resolver",
      rust: "rust-build-resolver",
      java: "java-build-resolver",
      kotlin: "kotlin-build-resolver",
      swift: "swift-build-resolver",
      cpp: "cpp-build-resolver",
      dart: "dart-build-resolver",
      flutter: "flutter-build-resolver",
    };

    return buildResolvers[framework] || "build-error-resolver";
  }

  /**
   * Get agents for code review by language
   */
  routeCodeReview(languages: string[]): string[] {
    const reviewers = new Set<string>(["code-reviewer"]);

    for (const lang of languages) {
      const agent = DOMAIN_AGENTS[lang]?.[0];
      if (agent) reviewers.add(agent);
    }

    return Array.from(reviewers);
  }
}
