/**
 * Skill Router - Maps task requirements to optimal skills
 */

import type { ClassificationResult, Intent } from "./classifier.ts";

export interface SkillRoute {
  skills: string[];
  sequence: "parallel" | "sequential";
  reason: string;
}

const INTENT_SKILLS: Record<Intent, string[]> = {
  implement: [
    "superpowers:brainstorming",
    "feature-dev",
    "superpowers:test-driven-development",
    "superpowers:verification-before-completion",
  ],
  fix: [
    "superpowers:systematic-debugging",
    "superpowers:test-driven-development",
    "superpowers:verification-before-completion",
  ],
  review: [
    "code-review",
    "superpowers:receiving-code-review",
  ],
  research: [
    "deep-research",
    "learn",
  ],
  design: [
    "superpowers:brainstorming",
    "superpowers:writing-plans",
    "plan",
  ],
  refactor: [
    "refactor-clean",
    "simplify",
    "superpowers:test-driven-development",
  ],
  test: [
    "superpowers:test-driven-development",
    "test-coverage",
  ],
  document: [
    "update-docs",
    "update-codemaps",
  ],
  optimize: [
    "refactor-clean",
    "simplify",
  ],
  "security-audit": [
    "security-scan",
    "code-review",
  ],
  debug: [
    "superpowers:systematic-debugging",
    "superpowers:verification-before-completion",
  ],
};

const WORKFLOW_SKILLS = {
  commit: ["prp-commit", "caveman:caveman-commit"],
  pr: ["prp-pr", "pr", "review-pr"],
  plan: ["plan", "superpowers:writing-plans", "plan-prd"],
  epic: ["epic-decompose", "epic-validate"],
  multi_agent: ["multi-plan", "multi-execute"],
};

const LANGUAGE_SKILLS: Record<string, string[]> = {
  typescript: ["react-review", "react-test", "react-build"],
  python: ["python-review"],
  go: ["go-review", "go-test", "go-build"],
  rust: ["rust-review", "rust-test", "rust-build"],
  cpp: ["cpp-review", "cpp-test", "cpp-build"],
  kotlin: ["kotlin-review", "kotlin-test", "kotlin-build"],
  flutter: ["flutter-review", "flutter-test", "flutter-build"],
};

const SPECIALIZED_SKILLS = {
  marketing: [
    "marketing-skills:marketing-plan",
    "marketing-skills:copywriting",
    "marketing-skills:seo-audit",
  ],
  seo: [
    "claude-seo:seo-audit",
    "claude-seo:seo-technical",
    "claude-seo:seo-content",
  ],
  frontend: [
    "frontend-design:frontend-design",
  ],
  chrome: [
    "chrome-devtools-mcp:chrome-devtools",
  ],
};

export class SkillRouter {
  route(classification: ClassificationResult, userPrompt: string): SkillRoute {
    const skills = new Set<string>();
    let sequence: "parallel" | "sequential" = "sequential";

    // Add intent-based skills
    const intentSkills = INTENT_SKILLS[classification.intent] || [];
    intentSkills.forEach((s) => skills.add(s));

    // Add domain-specific skills
    for (const domain of classification.domain) {
      const langSkills = LANGUAGE_SKILLS[domain] || [];
      langSkills.forEach((s) => skills.add(s));
    }

    // Add workflow skills based on keywords
    for (const [workflow, workflowSkills] of Object.entries(WORKFLOW_SKILLS)) {
      if (userPrompt.toLowerCase().includes(workflow)) {
        workflowSkills.forEach((s) => skills.add(s));
      }
    }

    // Add specialized skills
    for (const [domain, domainSkills] of Object.entries(SPECIALIZED_SKILLS)) {
      if (userPrompt.toLowerCase().includes(domain)) {
        domainSkills.forEach((s) => skills.add(s));
      }
    }

    // Determine execution sequence
    if (skills.size > 3 && classification.complexity === "HIGH") {
      sequence = "parallel";
    }

    const reason = this.buildReason(classification, Array.from(skills), sequence);

    return {
      skills: this.prioritizeSkills(Array.from(skills), classification),
      sequence,
      reason,
    };
  }

  private prioritizeSkills(skills: string[], classification: ClassificationResult): string[] {
    const priority: Record<string, number> = {
      "superpowers:brainstorming": 1,
      "superpowers:writing-plans": 2,
      plan: 3,
      "superpowers:systematic-debugging": 4,
      "superpowers:test-driven-development": 5,
      "feature-dev": 6,
      "code-review": 10,
      "superpowers:verification-before-completion": 20,
      "prp-commit": 30,
      "prp-pr": 31,
    };

    return skills.sort((a, b) => {
      const priorityA = priority[a] || 50;
      const priorityB = priority[b] || 50;
      return priorityA - priorityB;
    });
  }

  private buildReason(
    classification: ClassificationResult,
    skills: string[],
    sequence: "parallel" | "sequential"
  ): string {
    const parts = [
      `Intent: ${classification.intent}`,
      `Skills: ${skills.join(", ")}`,
      `Sequence: ${sequence}`,
    ];

    return parts.join(" | ");
  }

  /**
   * Get ECC workflow skills for full development cycle
   */
  getECCWorkflow(intent: Intent): string[] {
    const workflows: Record<Intent, string[]> = {
      implement: [
        "superpowers:brainstorming",
        "superpowers:writing-plans",
        "superpowers:test-driven-development",
        "feature-dev",
        "code-review",
        "superpowers:verification-before-completion",
      ],
      fix: [
        "superpowers:systematic-debugging",
        "superpowers:test-driven-development",
        "superpowers:verification-before-completion",
        "code-review",
      ],
      refactor: [
        "refactor-clean",
        "simplify",
        "superpowers:test-driven-development",
        "code-review",
      ],
      review: ["code-review", "security-scan"],
      design: ["superpowers:brainstorming", "superpowers:writing-plans"],
      research: ["deep-research", "learn"],
      test: ["superpowers:test-driven-development", "test-coverage"],
      document: ["update-docs", "update-codemaps"],
      optimize: ["refactor-clean", "simplify"],
      "security-audit": ["security-scan", "code-review"],
      debug: ["superpowers:systematic-debugging", "superpowers:verification-before-completion"],
    };

    return workflows[intent] || [];
  }

  /**
   * Get caveman mode skills
   */
  getCavemanSkills(intent: Intent): string[] {
    const cavemanMap: Partial<Record<Intent, string[]>> = {
      implement: ["caveman:cavecrew"],
      fix: ["caveman:cavecrew"],
      review: ["caveman:caveman-review"],
      refactor: ["caveman:cavecrew"],
    };

    return cavemanMap[intent] || [];
  }
}
