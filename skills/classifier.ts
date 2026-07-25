/**
 * Prompt Classifier - Analyzes user requests to extract routing signals
 */

export interface ClassificationResult {
  intent: Intent;
  complexity: Complexity;
  domain: Domain[];
  scope: Scope;
  timeSensitivity: TimeSensitivity;
  keywords: string[];
  confidence: number;
}

export type Intent =
  | "implement"
  | "fix"
  | "review"
  | "research"
  | "design"
  | "refactor"
  | "test"
  | "document"
  | "optimize"
  | "security-audit"
  | "debug";

export type Complexity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Domain =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "swift"
  | "kotlin"
  | "dart"
  | "php"
  | "ruby"
  | "csharp"
  | "cpp"
  | "react"
  | "vue"
  | "angular"
  | "flutter"
  | "security"
  | "performance"
  | "database"
  | "devops"
  | "testing"
  | "architecture"
  | "api"
  | "frontend"
  | "backend"
  | "mobile"
  | "web"
  | "infra"
  | "networking"
  | "general";

export type Scope =
  | "single-file"
  | "multi-file"
  | "module"
  | "architecture"
  | "system";

export type TimeSensitivity = "urgent" | "normal" | "can-wait";

const INTENT_KEYWORDS: Record<Intent, string[]> = {
  implement: ["add", "create", "build", "implement", "develop", "write new"],
  fix: ["fix", "bug", "error", "broken", "issue", "problem", "crash"],
  review: ["review", "audit", "check", "inspect", "examine", "analyze code"],
  research: ["research", "investigate", "explore", "find out", "learn about"],
  design: ["design", "architecture", "plan", "structure", "pattern"],
  refactor: ["refactor", "cleanup", "reorganize", "restructure", "improve"],
  test: ["test", "tdd", "unit test", "integration test", "e2e"],
  document: ["document", "readme", "docs", "comment", "explain"],
  optimize: ["optimize", "performance", "speed up", "improve performance"],
  "security-audit": ["security", "vulnerability", "auth", "permissions"],
  debug: ["debug", "trace", "diagnose", "troubleshoot"],
};

const COMPLEXITY_KEYWORDS = {
  LOW: ["simple", "quick", "format", "lint", "rename", "typo", "small"],
  MEDIUM: ["add feature", "refactor", "fix bug", "implement", "update"],
  HIGH: ["architecture", "design system", "complex", "large", "multi-file"],
  CRITICAL: [
    "security",
    "auth",
    "payment",
    "critical",
    "production",
    "data loss",
  ],
};

const DOMAIN_KEYWORDS: Record<Domain, string[]> = {
  typescript: ["typescript", ".ts", ".tsx", "type", "interface"],
  javascript: ["javascript", ".js", ".jsx", "node", "npm"],
  python: ["python", ".py", "pip", "django", "flask"],
  go: ["go", "golang", ".go", "goroutine"],
  rust: ["rust", ".rs", "cargo", "borrow"],
  java: ["java", ".java", "spring", "maven"],
  swift: ["swift", ".swift", "ios", "xcode"],
  kotlin: ["kotlin", ".kt", "android"],
  dart: ["dart", "flutter", ".dart"],
  php: ["php", ".php", "laravel", "composer"],
  ruby: ["ruby", ".rb", "rails", "gem"],
  csharp: ["c#", "csharp", ".cs", "dotnet"],
  cpp: ["c++", "cpp", ".cpp", ".h"],
  react: ["react", "jsx", "component", "hook"],
  vue: ["vue", ".vue", "composition api"],
  angular: ["angular", "@angular", "directive"],
  flutter: ["flutter", "widget", "stateful"],
  security: ["auth", "security", "vulnerability", "exploit", "xss", "sql injection"],
  performance: ["performance", "optimize", "slow", "cache", "bottleneck"],
  database: ["database", "sql", "query", "migration", "orm"],
  devops: ["ci/cd", "deploy", "docker", "kubernetes", "pipeline"],
  testing: ["test", "tdd", "jest", "pytest", "unit test"],
  architecture: ["architecture", "design pattern", "system design", "scalability"],
  api: ["api", "endpoint", "rest", "graphql", "openapi"],
  frontend: ["frontend", "ui", "css", "html", "styling"],
  backend: ["backend", "server", "api", "database"],
  mobile: ["mobile", "ios", "android", "app"],
  web: ["web", "browser", "html", "css"],
  infra: ["infrastructure", "terraform", "cloud", "aws", "gcp"],
  networking: ["network", "dns", "routing", "firewall"],
  general: [],
};

const SCOPE_INDICATORS = {
  "single-file": ["file", "function", "method", "class"],
  "multi-file": ["module", "package", "multiple files"],
  module: ["module", "package", "library"],
  architecture: ["architecture", "system", "design"],
  system: ["system", "infrastructure", "deployment"],
};

export class PromptClassifier {
  classify(prompt: string): ClassificationResult {
    const lower = prompt.toLowerCase();

    const intent = this.detectIntent(lower);
    const complexity = this.detectComplexity(lower, intent);
    const domain = this.detectDomain(lower);
    const scope = this.detectScope(lower, complexity);
    const timeSensitivity = this.detectTimeSensitivity(lower);
    const keywords = this.extractKeywords(lower);
    const confidence = this.calculateConfidence(intent, complexity, domain);

    return {
      intent,
      complexity,
      domain,
      scope,
      timeSensitivity,
      keywords,
      confidence,
    };
  }

  private detectIntent(prompt: string): Intent {
    const scores: Record<Intent, number> = {
      implement: 0,
      fix: 0,
      review: 0,
      research: 0,
      design: 0,
      refactor: 0,
      test: 0,
      document: 0,
      optimize: 0,
      "security-audit": 0,
      debug: 0,
    };

    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          scores[intent as Intent] += 1;
        }
      }
    }

    const maxScore = Math.max(...Object.values(scores));
    const topIntent = Object.entries(scores).find(([_, score]) => score === maxScore);

    return topIntent ? (topIntent[0] as Intent) : "implement";
  }

  private detectComplexity(prompt: string, intent: Intent): Complexity {
    // Security and architecture are always high complexity
    if (
      prompt.includes("security") ||
      prompt.includes("auth") ||
      prompt.includes("architecture")
    ) {
      return "CRITICAL";
    }

    for (const [complexity, keywords] of Object.entries(COMPLEXITY_KEYWORDS)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          return complexity as Complexity;
        }
      }
    }

    // Intent-based fallback
    if (["fix", "document", "test"].includes(intent)) return "LOW";
    if (["implement", "refactor"].includes(intent)) return "MEDIUM";
    if (["design", "research"].includes(intent)) return "HIGH";

    return "MEDIUM";
  }

  private detectDomain(prompt: string): Domain[] {
    const domains: Domain[] = [];

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          domains.push(domain as Domain);
          break;
        }
      }
    }

    return domains.length > 0 ? domains : ["general"];
  }

  private detectScope(prompt: string, complexity: Complexity): Scope {
    for (const [scope, indicators] of Object.entries(SCOPE_INDICATORS)) {
      for (const indicator of indicators) {
        if (prompt.includes(indicator)) {
          return scope as Scope;
        }
      }
    }

    // Complexity-based fallback
    if (complexity === "LOW") return "single-file";
    if (complexity === "MEDIUM") return "multi-file";
    if (complexity === "HIGH") return "module";
    return "architecture";
  }

  private detectTimeSensitivity(prompt: string): TimeSensitivity {
    const urgent = ["urgent", "asap", "now", "immediately", "critical", "production"];
    const canWait = ["later", "eventually", "when you can", "low priority"];

    for (const keyword of urgent) {
      if (prompt.includes(keyword)) return "urgent";
    }

    for (const keyword of canWait) {
      if (prompt.includes(keyword)) return "can-wait";
    }

    return "normal";
  }

  private extractKeywords(prompt: string): string[] {
    const words = prompt
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .filter((w) => !["the", "and", "for", "with", "this", "that"].includes(w));

    return [...new Set(words)].slice(0, 10);
  }

  private calculateConfidence(
    intent: Intent,
    complexity: Complexity,
    domains: Domain[]
  ): number {
    let confidence = 0.5;

    // Higher confidence if clear domain detected
    if (domains.length > 0 && !domains.includes("general")) {
      confidence += 0.2;
    }

    // Higher confidence if complexity is extreme
    if (complexity === "LOW" || complexity === "CRITICAL") {
      confidence += 0.15;
    }

    // Intent confidence boost
    if (["fix", "review", "security-audit"].includes(intent)) {
      confidence += 0.15;
    }

    return Math.min(confidence, 1.0);
  }
}
