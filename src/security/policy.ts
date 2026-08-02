import type { PlanNode, RiskLevel, RouterConfig } from "../contracts.ts";

export type ActionKind = "read" | "local-write" | "external-write" | "destructive";

export interface ActionRequest {
  kind: ActionKind;
  description: string;
  target?: string;
  riskLevel?: RiskLevel;
  source?: "plan" | "provider" | "verification" | "user";
  /** The node's verifier owns the one-time human decision after category checks pass. */
  approvalAtVerification?: boolean;
  /** A verified approval-gate ancestor already authorized this exact plan branch. */
  approvalSatisfied?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  action: ActionRequest;
}

export interface ApprovalRequest extends ActionRequest {
  reason: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface OperationalPolicyOptions {
  allowExternalWrites?: boolean;
  allowDestructiveActions?: boolean;
  requireApprovalForExternalWrites?: boolean;
  requireApprovalForDestructiveActions?: boolean;
  approvalHandler?: ApprovalHandler;
}

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(?:-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+[^\n]*--force)\b/i,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  /\bdelete\s+from\s+\S+\s*(?:;|$)/i,
  /\b(?:terraform|tofu)\s+destroy\b/i,
  /\bkubectl\s+delete\b/i,
  /\b(?:aws|gcloud|az)\b[^\n]*(?:delete|terminate|destroy|purge)\b/i,
  /\b(?:format|mkfs(?:\.\w+)?)\s+\/dev\//i,
  /\b(?:apagar|apague|deletar|delete|destruir|destrua|remover|remova)\b[^\n]*(?:produção|banco|database|cluster|servidor)\b/i,
];

const EXTERNAL_WRITE_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgh\s+(?:pr|issue|release)\s+(?:create|edit|close|merge|comment)\b/i,
  /\b(?:curl|http)\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
  /\b(?:curl|http|wget)\b[^\n]*(?:--data|-d\b|--form|-F\b|--upload-file|--post-data)\b/i,
  /\b(?:deploy|publish|release)\s+(?:to|on)\b/i,
  /\b(?:deploy|publish)\b/i,
  /\b(?:send|post)\s+(?:an?\s+)?(?:email|message|comment|notification)\b/i,
  /\b(?:create|update|delete|close|merge)\s+(?:an?\s+)?(?:pull request|issue|ticket)\b/i,
  /\b(?:abrir|abra|criar|crie|atualizar|atualize|fechar|feche|mesclar|mescle)\b[^\n]*(?:pull request|\bpr\b|issue|ticket)\b/i,
  /\b(?:enviar|envie|publicar|publique|implantar|implante)\b[^\n]*(?:email|mensagem|comentário|produção|release)\b/i,
];

export function classifyAction(text: string): ActionKind {
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text))) return "destructive";
  if (EXTERNAL_WRITE_PATTERNS.some((pattern) => pattern.test(text))) return "external-write";
  if (
    /\b(?:write|edit|modify|create|implement|fix|refactor|patch|escrever|editar|modificar|criar|implementar|corrigir|refatorar)\b/i.test(
      text,
    )
  ) {
    return "local-write";
  }
  return "read";
}

export function classifyTools(tools: readonly string[]): ActionKind {
  const normalized = tools.join(" ").replace(/[_:./-]+/g, " ");
  if (/\b(?:delete|destroy|drop|erase|purge|remove|reset|terminate)\b/i.test(normalized)) {
    return "destructive";
  }
  if (
    /\b(?:deploy|publish|push|release|send|upload)\b/i.test(normalized) ||
    (/\b(?:comment|create|merge|update)\b/i.test(normalized) &&
      /\b(?:github|gitlab|issue|message|pull request|remote|slack|ticket)\b/i.test(normalized))
  ) {
    return "external-write";
  }
  if (/\b(?:edit|write)\b/i.test(normalized)) return "local-write";
  return "read";
}

/**
 * Derives effective authority from the artifact and routed tools. Descriptions
 * on observational nodes may discuss a future mutation, but cannot grant that
 * node write authority by themselves.
 */
export function classifyNodeAction(node: PlanNode): ActionKind {
  const toolKind = classifyTools(node.route?.tools ?? node.routeRequest.requiredTools);
  const mutatingArtifact =
    node.expectedArtifact.type === "patch" || node.expectedArtifact.type === "document";
  if (toolKind === "read" && !mutatingArtifact) return "read";

  const textKind = classifyAction(
    [
      node.title,
      node.objective,
      node.expectedArtifact.description,
      ...node.verification.commands,
    ].join("\n"),
  );
  const artifactKind: ActionKind = mutatingArtifact ? "local-write" : "read";
  return moreRestrictiveAction(moreRestrictiveAction(textKind, toolKind), artifactKind);
}

export class OperationalPolicy {
  readonly #options: Required<Omit<OperationalPolicyOptions, "approvalHandler">> & {
    approvalHandler?: ApprovalHandler;
  };

  constructor(options: OperationalPolicyOptions = {}) {
    this.#options = {
      allowExternalWrites: options.allowExternalWrites ?? false,
      allowDestructiveActions: options.allowDestructiveActions ?? false,
      requireApprovalForExternalWrites: options.requireApprovalForExternalWrites ?? true,
      requireApprovalForDestructiveActions: options.requireApprovalForDestructiveActions ?? true,
      ...(options.approvalHandler ? { approvalHandler: options.approvalHandler } : {}),
    };
  }

  static fromConfig(config: RouterConfig, approvalHandler?: ApprovalHandler): OperationalPolicy {
    return new OperationalPolicy({
      allowExternalWrites: config.allowExternalWrites,
      allowDestructiveActions: config.allowDestructiveActions,
      ...(approvalHandler ? { approvalHandler } : {}),
    });
  }

  inspectNode(node: PlanNode): ActionRequest {
    return {
      kind: classifyNodeAction(node),
      description: [
        `Execute plan node ${node.id}: ${node.title}`,
        `Objective: ${node.objective}`,
        `Expected artifact: ${node.expectedArtifact.type} — ${node.expectedArtifact.description}`,
      ].join("\n"),
      target:
        node.expectedArtifact.paths && node.expectedArtifact.paths.length > 0
          ? node.expectedArtifact.paths.join(", ")
          : "current workspace",
      riskLevel: node.riskLevel,
      source: "plan",
      ...(node.verification.requireHumanApproval ? { approvalAtVerification: true } : {}),
    };
  }

  async authorize(action: ActionRequest): Promise<PolicyDecision> {
    const critical = action.riskLevel === "critical";
    if ((action.kind === "read" || action.kind === "local-write") && !critical) {
      return { allowed: true, requiresApproval: false, reason: "Local action allowed", action };
    }

    const isDestructive = action.kind === "destructive";
    const isExternal = action.kind === "external-write";
    const configured = isDestructive
      ? this.#options.allowDestructiveActions
      : isExternal
        ? this.#options.allowExternalWrites
        : true;
    const needsApproval = critical
      ? true
      : isDestructive
        ? this.#options.requireApprovalForDestructiveActions
        : this.#options.requireApprovalForExternalWrites;

    if (!configured) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `${action.kind} is disabled by operational policy`,
        action,
      };
    }

    if (!needsApproval) {
      return { allowed: true, requiresApproval: false, reason: "Allowed by policy", action };
    }

    if (action.approvalSatisfied) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: "Authorized by a verified human-approval ancestor",
        action,
      };
    }

    if (action.approvalAtVerification) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: "Category is enabled; exact human approval is deferred to verification",
        action,
      };
    }

    if (!this.#options.approvalHandler) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `${action.kind} requires human approval`,
        action,
      };
    }

    const approved = await this.#options.approvalHandler({
      ...action,
      reason: `${action.kind} requires explicit human approval`,
    });
    return {
      allowed: approved,
      requiresApproval: true,
      reason: approved ? "Approved by a human" : "Human approval was denied",
      action,
    };
  }

  guardrailText(): string {
    const external = this.#options.allowExternalWrites
      ? "External writes require explicit approval from the orchestrator."
      : "Do not perform external writes (push, publish, deploy, send, or mutate remote systems).";
    const destructive = this.#options.allowDestructiveActions
      ? "Destructive actions require explicit approval from the orchestrator."
      : "Do not perform destructive actions. Stop and report if one appears necessary.";
    return [
      "Operational safety policy:",
      "- Work only inside the supplied working directory.",
      `- ${external}`,
      `- ${destructive}`,
      "- Never expose credentials or include secrets in output.",
    ].join("\n");
  }
}

function moreRestrictiveAction(left: ActionKind, right: ActionKind): ActionKind {
  const rank: Readonly<Record<ActionKind, number>> = {
    read: 0,
    "local-write": 1,
    "external-write": 2,
    destructive: 3,
  };
  return rank[left] >= rank[right] ? left : right;
}
