import type { RiskLevel, TaskIntent } from "../contracts.ts";
import { type ActionKind, classifyAction } from "../security/policy.ts";

export type TaskComplexity = "simple" | "moderate" | "complex" | "systemic";

export interface PromptClassification {
  intent: TaskIntent;
  intentSequence: TaskIntent[];
  domains: string[];
  languages: string[];
  riskLevel: RiskLevel;
  complexity: TaskComplexity;
  confidence: number;
  ambiguity: number;
  requiresHumanApproval: boolean;
  matchedSignals: string[];
  intentScores: Record<TaskIntent, number>;
}

interface WeightedSignal {
  readonly phrase: string;
  readonly weight: number;
}

interface IntentSignalMatch extends WeightedSignal {
  readonly intent: TaskIntent;
  readonly start: number;
  readonly length: number;
}

const INTENTS: readonly TaskIntent[] = [
  "implement",
  "fix",
  "review",
  "research",
  "design",
  "refactor",
  "test",
  "document",
  "optimize",
  "security-audit",
  "debug",
];

const INTENT_SIGNALS: Readonly<Record<TaskIntent, readonly WeightedSignal[]>> = {
  implement: signals(
    3,
    "implement",
    "implement it",
    "build",
    "create",
    "add",
    "develop",
    "integrate",
    "change the",
    "update the",
    "modify the",
    "deploy",
    "publish",
    "implemente",
    "implementar",
    "crie",
    "criar",
    "adicione",
    "adicionar",
    "construa",
    "desenvolva",
    "integre",
    "altere",
    "modifique",
    "implante",
    "publique",
    "implementar esto",
    "crear",
    "cree",
    "añada",
    "agregue",
    "desarrolle",
    "integre",
    "cambie",
    "modifique",
    "despliegue",
    "publique",
  ),
  fix: signals(
    3,
    "fix",
    "repair",
    "resolve the bug",
    "correct the bug",
    "make it work",
    "corrija",
    "corrigir",
    "conserte",
    "consertar",
    "repare",
    "resolver o bug",
    "faça funcionar",
    "arregle",
    "arreglar",
    "corrija el error",
    "repare",
    "resolver el bug",
  ),
  review: signals(
    3,
    "review",
    "code review",
    "inspect the code",
    "assess",
    "critique",
    "revise",
    "revisar",
    "faça uma revisão",
    "inspecione o código",
    "avalie",
    "revisión de código",
    "revise el código",
    "inspeccione",
    "evalúe",
  ),
  research: signals(
    3,
    "research",
    "look up",
    "find out",
    "compare options",
    "survey",
    "pesquise",
    "pesquisar",
    "levante informações",
    "descubra",
    "compare opções",
    "estude",
    "investigue opciones",
    "buscar información",
    "averigüe",
    "compare opciones",
    "estudie",
  ),
  design: signals(
    3,
    "design",
    "architect",
    "architecture proposal",
    "technical plan",
    "system design",
    "desenhe",
    "proponha a arquitetura",
    "plano técnico",
    "projete",
    "arquitetar",
    "diseñe",
    "proponga la arquitectura",
    "plan técnico",
    "arquitectura del sistema",
  ),
  refactor: signals(
    4,
    "refactor",
    "restructure the code",
    "clean up the code",
    "simplify the code",
    "refatore",
    "refatorar",
    "reestruture o código",
    "simplifique o código",
    "refactorice",
    "refactorizar",
    "reestructure el código",
    "simplifique el código",
  ),
  test: signals(
    3,
    "test",
    "write tests",
    "add tests",
    "test coverage",
    "validate with tests",
    "teste",
    "testar",
    "escreva testes",
    "adicione testes",
    "cobertura de testes",
    "pruebe",
    "probar",
    "escriba pruebas",
    "añada pruebas",
    "cobertura de pruebas",
  ),
  document: signals(
    3,
    "document",
    "write documentation",
    "update the readme",
    "write a guide",
    "explain how",
    "documente",
    "documentar",
    "escreva a documentação",
    "atualize o readme",
    "crie um guia",
    "explique como",
    "documente",
    "escriba la documentación",
    "actualice el readme",
    "cree una guía",
    "explique cómo",
  ),
  optimize: signals(
    4,
    "optimize",
    "improve performance",
    "reduce latency",
    "reduce memory",
    "reduce tokens",
    "make faster",
    "otimize",
    "otimizar",
    "melhore o desempenho",
    "reduza a latência",
    "reduza memória",
    "economize tokens",
    "optimice",
    "mejore el rendimiento",
    "reduzca la latencia",
    "reduzca memoria",
    "ahorre tokens",
    "improve",
    "melhore",
    "mejore",
  ),
  "security-audit": signals(
    5,
    "security audit",
    "audit security",
    "threat model",
    "penetration test",
    "vulnerability assessment",
    "auditoria de segurança",
    "audite a segurança",
    "modelo de ameaças",
    "teste de invasão",
    "análise de vulnerabilidades",
    "auditoría de seguridad",
    "audite la seguridad",
    "modelo de amenazas",
    "prueba de penetración",
    "análisis de vulnerabilidades",
  ),
  debug: signals(
    4,
    "debug",
    "diagnose",
    "root cause",
    "trace the error",
    "why is this failing",
    "investigate the bug",
    "depure",
    "diagnostique",
    "causa raiz",
    "rastreie o erro",
    "por que está falhando",
    "investigue o bug",
    "depure",
    "diagnostique",
    "causa raíz",
    "rastree el error",
    "por qué está fallando",
    "investigue el bug",
  ),
};

const DOMAIN_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  security: [
    "security",
    "authentication",
    "authorization",
    "login",
    "sign in",
    "oauth",
    "permission",
    "permissions",
    "secret",
    "secrets",
    "vulnerability",
    "segurança",
    "autenticação",
    "autorização",
    "entrar na conta",
    "permissão",
    "permissões",
    "segredo",
    "segredos",
    "vulnerabilidade",
    "seguridad",
    "autenticación",
    "autorización",
    "inicio de sesión",
    "permiso",
    "permisos",
    "secreto",
    "secretos",
    "vulnerabilidad",
  ],
  frontend: [
    "frontend",
    "react",
    "vue",
    "svelte",
    "css",
    "browser",
    "ui",
    "interface do usuário",
    "interfaz de usuario",
  ],
  backend: ["backend", "server", "api", "endpoint", "service", "servidor", "serviço", "servicio"],
  database: [
    "database",
    "sql",
    "postgres",
    "mysql",
    "migration",
    "schema",
    "banco de dados",
    "migração",
    "base de datos",
    "migración",
  ],
  devops: [
    "devops",
    "ci cd",
    "pipeline",
    "docker",
    "kubernetes",
    "deploy",
    "deployment",
    "implantação",
    "produção",
    "despliegue",
    "producción",
  ],
  testing: [
    "test",
    "tests",
    "testing",
    "spec",
    "coverage",
    "teste",
    "testes",
    "cobertura",
    "prueba",
    "pruebas",
  ],
  documentation: [
    "documentation",
    "readme",
    "guide",
    "docs",
    "documentação",
    "guia",
    "documentación",
  ],
  performance: [
    "performance",
    "latency",
    "benchmark",
    "memory usage",
    "tokens",
    "desempenho",
    "latência",
    "uso de memória",
    "rendimiento",
    "latencia",
  ],
  data: [
    "analytics",
    "dataset",
    "etl",
    "metric",
    "dashboard",
    "dados",
    "métrica",
    "painel",
    "datos",
    "métrica",
    "tablero",
  ],
  payments: [
    "payment",
    "payments",
    "billing",
    "checkout",
    "charge customers",
    "pagamento",
    "pagamentos",
    "cobrança",
    "cobre clientes",
    "pago",
    "pagos",
    "facturación",
    "cobre a clientes",
  ],
  ai: ["ai", "llm", "model", "prompt", "agent", "skill", "ia", "modelo", "agente", "habilidade"],
  mobile: ["mobile", "ios", "android", "swift", "kotlin", "aplicativo móvel", "aplicación móvil"],
};

const LANGUAGE_MARKERS: Readonly<Record<string, readonly string[]>> = {
  pt: [
    "o",
    "a",
    "os",
    "as",
    "de",
    "do",
    "da",
    "para",
    "com",
    "sem",
    "que",
    "uma",
    "um",
    "por",
    "não",
    "faça",
    "precisa",
    "corrija",
    "implemente",
    "documente",
    "melhore",
    "autenticacao",
    "desempenho",
  ],
  en: [
    "the",
    "a",
    "an",
    "of",
    "to",
    "for",
    "with",
    "without",
    "that",
    "this",
    "please",
    "must",
    "should",
    "implement",
    "review",
    "document",
    "improve",
  ],
  es: [
    "el",
    "la",
    "los",
    "las",
    "de",
    "del",
    "para",
    "con",
    "sin",
    "que",
    "una",
    "un",
    "por",
    "no",
    "haga",
    "necesita",
    "corrija",
    "implemente",
    "documente",
    "mejore",
  ],
};

const HIGH_RISK_SIGNALS = [
  "authentication",
  "authorization",
  "login",
  "sign in",
  "credentials",
  "secret",
  "private key",
  "personal data",
  "pii",
  "migration",
  "autenticação",
  "autorização",
  "entrar na conta",
  "credenciais",
  "segredo",
  "chave privada",
  "dados pessoais",
  "migração",
  "autenticación",
  "autorización",
  "inicio de sesión",
  "credenciales",
  "secreto",
  "clave privada",
  "datos personales",
  "migración",
];

const CRITICAL_RISK_SIGNALS = [
  "delete production",
  "drop table",
  "drop database",
  "production deploy",
  "deploy to production",
  "rotate production secrets",
  "payment processing",
  "charge customers",
  "transfer money",
  "disable security",
  "erase data",
  "apague produção",
  "exclua em produção",
  "derrube a tabela",
  "apague o banco",
  "deploy em produção",
  "implante em produção",
  "processe pagamentos",
  "cobre clientes",
  "transfira dinheiro",
  "desative a segurança",
  "apague dados",
  "elimine producción",
  "borre en producción",
  "elimine la tabla",
  "borre la base de datos",
  "despliegue en producción",
  "procese pagos",
  "cobre a clientes",
  "transfiera dinero",
  "desactive la seguridad",
  "borre datos",
];

const ACCESS_CONTROL_SIGNALS = [
  "administrator permissions",
  "admin permissions",
  "access permissions",
  "roles and permissions",
  "permissões de acesso",
  "permissões dos administradores",
  "papéis e permissões",
  "permisos de acceso",
  "permisos de administradores",
  "roles y permisos",
];

const EXTERNAL_ACTION_SIGNALS = [
  "deploy",
  "publish",
  "push",
  "open a pull request",
  "create a pull request",
  "send email",
  "post message",
  "purchase",
  "pay",
  "implante",
  "publique",
  "envie",
  "abra um pull request",
  "crie um pull request",
  "mande um email",
  "compre",
  "pague",
  "despliegue",
  "publique",
  "envíe",
  "abra un pull request",
  "cree un pull request",
  "compre",
  "pague",
];

const DESTRUCTIVE_ACTION_SIGNALS = [
  "delete",
  "remove permanently",
  "drop",
  "truncate",
  "overwrite",
  "erase",
  "destroy",
  "revoke",
  "exclua",
  "apague",
  "remova permanentemente",
  "sobrescreva",
  "destrua",
  "revogue",
  "elimine",
  "borre",
  "quite permanentemente",
  "sobrescriba",
  "destruya",
  "revoque",
];

function signals(weight: number, ...phrases: string[]): WeightedSignal[] {
  return phrases.map((phrase) => ({ phrase, weight }));
}

export function normalizePromptText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/gu, " ")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim();
}

export function tokenizePrompt(value: string): string[] {
  const normalized = normalizePromptText(value);
  return normalized ? normalized.split(/\s+/u) : [];
}

function phraseTokens(phrase: string): string[] {
  return tokenizePrompt(phrase);
}

function containsPhrase(tokens: readonly string[], phrase: string): boolean {
  return phraseStart(tokens, phrase) >= 0;
}

function phraseStart(tokens: readonly string[], phrase: string): number {
  return phraseStarts(tokens, phrase)[0] ?? -1;
}

function phraseStarts(tokens: readonly string[], phrase: string): number[] {
  const expected = phraseTokens(phrase);
  if (expected.length === 0 || expected.length > tokens.length) return [];
  const starts: number[] = [];

  outer: for (let start = 0; start <= tokens.length - expected.length; start += 1) {
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (tokens[start + offset] !== expected[offset]) continue outer;
    }
    starts.push(start);
  }
  return starts;
}

function explicitIntentMatches(tokens: readonly string[]): IntentSignalMatch[] {
  const matches = new Map<string, IntentSignalMatch>();
  for (const intent of INTENTS) {
    for (const signal of INTENT_SIGNALS[intent]) {
      const length = phraseTokens(signal.phrase).length;
      for (const start of phraseStarts(tokens, signal.phrase)) {
        const key = `${intent}:${normalizePromptText(signal.phrase)}:${start}`;
        const existing = matches.get(key);
        if (!existing || length > existing.length || signal.weight > existing.weight) {
          matches.set(key, { ...signal, intent, start, length });
        }
      }
    }
  }

  const candidates = [...matches.values()];
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (specific) =>
          specific !== candidate &&
          specific.start <= candidate.start &&
          specific.start + specific.length >= candidate.start + candidate.length &&
          specific.length > candidate.length,
      ),
  );
}

function intentClauseByToken(prompt: string, tokenCount: number): number[] {
  const clauses: number[] = [];
  const boundary = /(?:[.!?;\n]+|\b(?:then|afterwards|depois|seguida|luego)\b)/giu;
  let cursor = 0;
  let clause = 0;
  for (const match of prompt.matchAll(boundary)) {
    const start = match.index ?? cursor;
    clauses.push(...tokenizePrompt(prompt.slice(cursor, start)).map(() => clause));
    clauses.push(...tokenizePrompt(match[0]).map(() => clause));
    clause += 1;
    cursor = start + match[0].length;
  }
  clauses.push(...tokenizePrompt(prompt.slice(cursor)).map(() => clause));
  return clauses.length === tokenCount ? clauses : Array.from({ length: tokenCount }, () => 0);
}

function orderedIntentSequence(
  matches: readonly IntentSignalMatch[],
  clauseByToken: readonly number[],
): TaskIntent[] {
  const priority = new Map(INTENTS.map((intent, index) => [intent, index]));
  const ordered = [...matches].sort(
    (left, right) =>
      left.start - right.start ||
      right.length - left.length ||
      right.weight - left.weight ||
      (priority.get(left.intent) ?? 0) - (priority.get(right.intent) ?? 0),
  );
  const sequence: TaskIntent[] = [];
  let previousClause = -1;
  for (const match of ordered) {
    const clause = clauseByToken[match.start] ?? 0;
    if (sequence.at(-1) === match.intent && clause === previousClause) continue;
    sequence.push(match.intent);
    previousClause = clause;
  }
  return sequence;
}

function matchedPhrases(tokens: readonly string[], phrases: readonly string[]): string[] {
  return phrases.filter((phrase) => containsPhrase(tokens, phrase));
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function detectLanguages(tokens: readonly string[]): string[] {
  const scores = Object.entries(LANGUAGE_MARKERS).map(([language, markers]) => ({
    language,
    score: markers.reduce((total, marker) => total + (containsPhrase(tokens, marker) ? 1 : 0), 0),
  }));
  const maximum = Math.max(0, ...scores.map(({ score }) => score));
  if (maximum === 0) return ["und"];

  const detected = scores
    .filter(({ score }) => score >= Math.max(2, maximum * 0.65))
    .sort((left, right) => right.score - left.score || left.language.localeCompare(right.language))
    .map(({ language }) => language);
  return detected.length > 0 ? detected : ["und"];
}

function classifyDomains(tokens: readonly string[]): string[] {
  const matches = Object.entries(DOMAIN_SIGNALS)
    .map(([domain, phrases]) => ({ domain, count: matchedPhrases(tokens, phrases).length }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain))
    .map(({ domain }) => domain);
  return matches.length > 0 ? matches : ["general"];
}

function classifyRisk(
  tokens: readonly string[],
  domains: readonly string[],
  intents: readonly TaskIntent[],
  syntaxAction: ActionKind,
): RiskLevel {
  if (matchedPhrases(tokens, CRITICAL_RISK_SIGNALS).length > 0) return "critical";
  // A matched destructive command is an unambiguous operator instruction, not a
  // passing mention of a word, so it outranks every heuristic below.
  if (syntaxAction === "destructive") return "critical";
  const mutatingIntent = intents.some((intent) =>
    ["implement", "fix", "refactor", "optimize", "debug"].includes(intent),
  );
  const productionTarget = ["production", "produção", "producción"].some((target) =>
    containsPhrase(tokens, target),
  );
  if (mutatingIntent && (domains.includes("payments") || productionTarget)) return "critical";
  if (mutatingIntent && matchedPhrases(tokens, ACCESS_CONTROL_SIGNALS).length > 0)
    return "critical";
  if (matchedPhrases(tokens, HIGH_RISK_SIGNALS).length > 0 || intents.includes("security-audit"))
    return "high";
  if (domains.includes("payments")) return "high";
  if (domains.includes("database") || domains.includes("devops") || domains.includes("security"))
    return "medium";
  return "low";
}

function classifyComplexity(
  tokens: readonly string[],
  domains: readonly string[],
  risk: RiskLevel,
): TaskComplexity {
  const conjunctions = ["and", "then", "also", "e", "depois", "tambem", "y", "luego", "tambien"];
  const boundaries = conjunctions.reduce(
    (total, phrase) => total + matchedPhrases(tokens, [phrase]).length,
    0,
  );
  if (risk === "critical" || domains.length >= 4 || tokens.length > 160 || boundaries >= 4)
    return "systemic";
  if (risk === "high" || domains.length >= 3 || tokens.length > 80 || boundaries >= 2)
    return "complex";
  if (domains.length >= 2 || tokens.length > 28 || boundaries >= 1) return "moderate";
  return "simple";
}

function blankIntentScores(): Record<TaskIntent, number> {
  return {
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
}

/**
 * Classifies natural-language work requests without substring matching. All
 * signals are matched as complete Unicode-normalized token sequences, so short
 * tokens such as `go`, `pr`, or `app` cannot collide inside unrelated words.
 */
export function classifyPrompt(prompt: string): PromptClassification {
  const tokens = tokenizePrompt(prompt);
  const scores = blankIntentScores();
  const matchedSignals: string[] = [];
  const firstActionIndex = new Map<TaskIntent, number>();

  const explicitMatches = explicitIntentMatches(tokens);
  for (const signal of explicitMatches) {
    scores[signal.intent] += signal.weight + Math.min(1.5, signal.length * 0.25);
    firstActionIndex.set(
      signal.intent,
      Math.min(firstActionIndex.get(signal.intent) ?? Number.POSITIVE_INFINITY, signal.start),
    );
    matchedSignals.push(`${signal.intent}:${signal.phrase}`);
  }

  const detectedSequence = orderedIntentSequence(
    explicitMatches,
    intentClauseByToken(prompt, tokens.length),
  );

  const earliestAction = Math.min(Number.POSITIVE_INFINITY, ...firstActionIndex.values());
  for (const [intent, index] of firstActionIndex) {
    if (index === earliestAction) scores[intent] += 0.5;
  }

  // Nouns are useful only as tie-breakers. They never override an explicit
  // action verb and therefore do not cause "tests are failing" to mean
  // "write tests" or "security feature" to mean "run a security audit".
  if (
    containsPhrase(tokens, "bug") ||
    containsPhrase(tokens, "error") ||
    containsPhrase(tokens, "erro")
  ) {
    scores.debug += 0.75;
    scores.fix += 0.5;
  }
  if (containsPhrase(tokens, "documentation") || containsPhrase(tokens, "documentacao"))
    scores.document += 0.5;
  if (containsPhrase(tokens, "performance") || containsPhrase(tokens, "desempenho"))
    scores.optimize += 0.5;

  const ranked = INTENTS.map((intent, priority) => ({
    intent,
    score: scores[intent],
    priority,
  })).sort((left, right) => right.score - left.score || left.priority - right.priority);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const topScore = winner?.score ?? 0;
  const secondScore = runnerUp?.score ?? 0;
  // No action signal is a read-only research request, never implicit mutation.
  const intent: TaskIntent =
    detectedSequence[0] ?? (topScore > 0 && winner ? winner.intent : "research");
  const intentSequence = detectedSequence.length > 0 ? detectedSequence : [intent];
  const domains = classifyDomains(tokens);
  // Token signals cannot see command syntax: normalizePromptText strips the
  // operators `rm -rf`, `git reset --hard`, and `mkfs /dev/...` depend on, and
  // none of them contains a destructive word form. Classify the raw prompt with
  // the same policy patterns the runtime uses so both spellings reach the gate.
  const syntaxAction = classifyAction(prompt);
  const riskLevel = classifyRisk(tokens, domains, intentSequence, syntaxAction);
  const complexity = classifyComplexity(tokens, domains, riskLevel);

  const weakRequestPenalty = tokens.length < 4 ? 0.35 : tokens.length < 8 ? 0.15 : 0;
  const tiePenalty = topScore > 0 ? clamp(secondScore / topScore) * 0.4 : 0.45;
  const noSignalPenalty = topScore === 0 ? 0.35 : 0;
  const ambiguity = clamp(0.08 + weakRequestPenalty + tiePenalty + noSignalPenalty);
  const confidence = clamp(1 - ambiguity);
  const external = matchedPhrases(tokens, EXTERNAL_ACTION_SIGNALS);
  const destructive = matchedPhrases(tokens, DESTRUCTIVE_ACTION_SIGNALS);
  matchedSignals.push(...external.map((signal) => `external:${signal}`));
  matchedSignals.push(...destructive.map((signal) => `destructive:${signal}`));
  if (syntaxAction === "destructive") matchedSignals.push("destructive:command-syntax");
  if (syntaxAction === "external-write") matchedSignals.push("external:command-syntax");

  return {
    intent,
    intentSequence,
    domains,
    languages: detectLanguages(tokens),
    riskLevel,
    complexity,
    confidence,
    ambiguity,
    requiresHumanApproval:
      riskLevel === "critical" ||
      external.length > 0 ||
      destructive.length > 0 ||
      syntaxAction === "destructive" ||
      syntaxAction === "external-write",
    matchedSignals: [...new Set(matchedSignals)],
    intentScores: scores,
  };
}
