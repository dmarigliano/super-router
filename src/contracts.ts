export type TaskIntent =
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

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type EffortLevel = "economy" | "balanced" | "deep" | "max";
export type ExecutionState =
  | "pending"
  | "running"
  | "simulated"
  | "verified"
  | "failed"
  | "needs-escalation"
  | "needs-human"
  | "budget-exhausted"
  | "skipped";

export interface Budget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxAttempts: number;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  kind: "command" | "artifact" | "policy" | "human";
  command?: string;
  required: boolean;
}

export interface TaskSpec {
  id: string;
  objective: string;
  intent: TaskIntent;
  /** Ordered actions detected in the request; repeated intents remain distinct. Falls back to `intent`. */
  intentSequence?: TaskIntent[];
  domains: string[];
  languages: string[];
  riskLevel: RiskLevel;
  ambiguity: number;
  qualityFloor: number;
  constraints: string[];
  deliverables: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  budget: Budget;
  privacy: "ephemeral" | "local-memory" | "cloud-allowed";
  requiresHumanApproval: boolean;
}

export interface ArtifactContract {
  type: "analysis" | "plan" | "patch" | "test-report" | "review" | "document" | "result";
  description: string;
  paths?: string[];
}

export interface VerificationPolicy {
  commands: string[];
  requireIndependentReview: boolean;
  /** Require an explicit machine-readable PASS/FAIL verdict from this review step. */
  reviewVerdictRequired?: boolean;
  requireHumanApproval: boolean;
  /** Exact protected node authorized by this one-time approval gate. */
  approvalForNodeId?: string;
  minimumScore: number;
}

export interface RouteRequest {
  stepId: string;
  taskIntent: TaskIntent;
  domains: string[];
  riskLevel: RiskLevel;
  qualityFloor: number;
  expectedInputTokens: number;
  /** Hard prompt-input ceiling allocated to this step. */
  maxInputTokens?: number;
  expectedOutputTokens: number;
  /** A candidate whose predicted latency exceeds this run boundary is ineligible. */
  maxLatencyMs?: number;
  requiredTools: string[];
  preferredProvider?: string;
}

export interface RouteDecision {
  provider: string;
  model: string;
  effort: EffortLevel;
  agent?: string;
  skills: string[];
  tools: string[];
  expectedQuality: number;
  expectedCostUsd: number;
  expectedLatencyMs: number;
  reason: string;
}

export interface PlanNode {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  expectedArtifact: ArtifactContract;
  riskLevel: RiskLevel;
  qualityFloor: number;
  routeRequest: RouteRequest;
  route?: RouteDecision;
  contextRefs: string[];
  contextBudget: number;
  outputBudget: number;
  maxCostUsd: number;
  maxAttempts: number;
  verification: VerificationPolicy;
}

export interface ExecutionPlan {
  id: string;
  task: TaskSpec;
  nodes: PlanNode[];
  createdAt: string;
  /** Sum of predicted provider-call costs for the selected primary route of every node. */
  predictedPrimaryCallCostUsd: number;
  explanation: string[];
}

export interface ModelCapability {
  provider: string;
  model: string;
  displayName: string;
  taskTypes: TaskIntent[];
  domains: string[];
  supportedEfforts: EffortLevel[];
  tools: string[];
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  qualityPrior: number;
  latencyPriorMs: number;
  enabled: boolean;
}

export interface AgentCapability {
  id: string;
  description: string;
  /** Size of the private complete manifest body available for prompt delivery. */
  instructionCharacters?: number;
  /** Runtime providers this capability may specialize. Omitted means provider-neutral. */
  providers?: string[];
  taskTypes: TaskIntent[];
  domains: string[];
  tools: string[];
  skills: string[];
  riskCeiling: RiskLevel;
  contextOverheadTokens: number;
  enabled: boolean;
}

export interface SkillCapability {
  id: string;
  description: string;
  /** Size of the private complete manifest body available for prompt delivery. */
  instructionCharacters?: number;
  /** Runtime providers this capability may specialize. Omitted means provider-neutral. */
  providers?: string[];
  taskTypes: TaskIntent[];
  domains: string[];
  requiredTools: string[];
  contextOverheadTokens: number;
  trusted: boolean;
  enabled: boolean;
}

export interface CapabilitySnapshot {
  models: ModelCapability[];
  agents: AgentCapability[];
  skills: SkillCapability[];
  discoveredAt: string;
}

export interface MaterializedCapabilityInstruction {
  id: string;
  instructions: string;
}

/** Selected capabilities whose complete instructions were embedded into the provider prompt. */
export interface MaterializedRouteCapabilities {
  delivery: "prompt";
  agent?: MaterializedCapabilityInstruction;
  skills: MaterializedCapabilityInstruction[];
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  /** True when costUsd is authoritative, including a known zero for subscription billing. */
  costFinal?: boolean;
  /** True when one or more token counts came from a conservative reservation. */
  estimated?: boolean;
  durationMs: number;
}

export interface VerificationResult {
  passed: boolean;
  score: number;
  checks: Array<{
    name: string;
    passed: boolean;
    details: string;
    durationMs: number;
  }>;
  reason: string;
}

export interface StepResult {
  stepId: string;
  state: ExecutionState;
  attempt: number;
  route: RouteDecision;
  output: string;
  artifacts: string[];
  usage: UsageRecord;
  verification?: VerificationResult;
  error?: string;
}

export interface RunResult {
  runId: string;
  plan: ExecutionPlan;
  state: ExecutionState;
  steps: StepResult[];
  usage: UsageRecord;
  /** Task-level evaluation of every required acceptance criterion for a real run. */
  acceptance?: VerificationResult;
  startedAt: string;
  finishedAt: string;
  summary: string;
  /** True when the run used simulation mode; only a structurally successful run has state simulated. */
  simulated?: boolean;
}

export interface ProviderConfig {
  id: string;
  enabled: boolean;
  transport: "cli" | "http";
  billingMode: "subscription" | "metered";
  executable?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  sendEffort?: boolean;
  defaultModel: string;
  models: ModelCapability[];
}

export interface RouterConfig {
  profile: "economy" | "balanced" | "quality" | "compliance";
  preferredProvider?: string;
  qualityFloor: number;
  concurrency: number;
  dryRun: boolean;
  explain: boolean;
  allowExternalWrites: boolean;
  allowDestructiveActions: boolean;
  memory: {
    enabled: boolean;
    persistRawPrompts: boolean;
    maxResults: number;
  };
  telemetry: {
    enabled: boolean;
    includePromptHash: boolean;
    retentionDays: number;
  };
  budget: Budget;
  providers: ProviderConfig[];
}

export interface ExecutionContext {
  cwd: string;
  runId: string;
  task: TaskSpec;
  step: PlanNode;
  route: RouteDecision;
  prompt: string;
  materializedCapabilities?: MaterializedRouteCapabilities;
  timeoutMs: number;
}

export interface ProviderExecutionResult {
  output: string;
  artifacts: string[];
  usage: UsageRecord;
  raw?: unknown;
}

export interface ProviderAvailability {
  installed: boolean;
  authenticated: boolean;
  available: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  checkAvailability?(): Promise<ProviderAvailability>;
  isAvailable(): Promise<boolean>;
  execute(context: ExecutionContext): Promise<ProviderExecutionResult>;
}
