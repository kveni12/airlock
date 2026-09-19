import type { FindingDraft } from "../findings/findingService.js";
import { RESOURCE_LEXICON, contentWords } from "../request/requestAnalyzer.js";
import type {
  AgentIntent,
  AlignmentStatus,
  EventSeverity,
  HumanRequest,
  RequestAnalysis,
  RequestResource,
  RequestResourceCategory,
  RequestStatement
} from "../types.js";

export interface RequestIntentAnalysis {
  status: AlignmentStatus;
  findings: FindingDraft[];
  checks: Array<{ check: RequestIntentCheck; passed: boolean; detail?: string }>;
}

export type RequestIntentCheck =
  | "explicit_constraint_violation"
  | "missing_requested_objective"
  | "scope_expansion"
  | "constraint_not_acknowledged";

const SCOPE_EXPANSION_VERBS = /\b(refactor|rewrite|migrate|replace|redesign|re-architect|rearchitect|upgrade|overhaul|rename across|restructure)\b/i;
const OBJECTIVE_OVERLAP_THRESHOLD = 0.34;

const INFRA_FILE_PATTERNS = [/(^|\/)infra(\/|$)/i, /\.tf$/i, /(^|\/)terraform(\/|$)/i, /(^|\/)k8s(\/|$)/i, /(^|\/)helm(\/|$)/i, /dockerfile/i, /docker-compose/i, /(^|\/)\.github\/workflows(\/|$)/i, /(^|\/)deploy(ment)?s?(\/|$)/i];
const DATABASE_FILE_PATTERNS = [/(^|\/)migrations?(\/|$)/i, /(^|\/)db(\/|$)/i, /(^|\/)database(\/|$)/i, /\.sql$/i, /(^|\/)schema\.(prisma|sql|ts|js|rb)$/i, /(^|\/)prisma(\/|$)/i];
const CONFIG_FILE_PATTERNS = [/(^|\/)config(s)?(\/|$)/i, /\.env(\.|$)/i, /(^|\/)settings\./i];
const SECRET_FILE_PATTERNS = [/\.env(\.|$)/i, /\.pem$/i, /\.key$/i, /secrets?(\/|\.)/i];

/**
 * Deterministic comparison between the human request (raw + analyzed) and the agent's declared intent.
 * Only explicit request statements can produce conflict-level findings; everything else is a warning
 * whose evidence is marked as inferred.
 */
export class RequestIntentAnalyzer {
  analyze(request: HumanRequest, analysis: RequestAnalysis, intent: AgentIntent): RequestIntentAnalysis {
    const findings: FindingDraft[] = [];
    const checks: RequestIntentAnalysis["checks"] = [];
    const base = { taskId: intent.taskId, runId: intent.runId, requestId: request.id, intentId: intent.id };

    const violations = this.constraintViolations(analysis, intent);
    checks.push({ check: "explicit_constraint_violation", passed: violations.length === 0 });
    for (const violation of violations) {
      findings.push(
        finding(base, "spec_drift", "high", "Intent violates explicit user constraint", violation.description, {
          humanRequestExcerpt: violation.constraint.excerpt ?? violation.constraint.text,
          agentIntentExcerpt: violation.intentExcerpt,
          declaredResource: violation.resource.resource,
          observedResource: violation.intentExcerpt,
          verification: "independent"
        })
      );
    }

    const missing = this.missingObjectives(analysis, intent);
    checks.push({ check: "missing_requested_objective", passed: missing.length === 0 });
    for (const objective of missing) {
      findings.push(
        finding(
          base,
          "spec_drift",
          "medium",
          "Requested objective not addressed in intent",
          `The human asked for "${objective.text}" but no planned action, goal, or expected file in the declared intent appears to address it. This is a lexical comparison; confirm with the agent before execution.`,
          {
            humanRequestExcerpt: objective.excerpt ?? objective.text,
            agentIntentExcerpt: intent.plannedChanges.join("; "),
            declaredResource: objective.text,
            verification: "inferred"
          }
        )
      );
    }

    const expansions = this.scopeExpansions(request, analysis, intent);
    checks.push({ check: "scope_expansion", passed: expansions.length === 0 });
    for (const action of expansions) {
      findings.push(
        finding(
          base,
          "spec_drift",
          "medium",
          "Intent may expand beyond the requested scope",
          `The planned action "${action}" uses broad-change language and shares no wording with the human request. Treat as possible scope expansion, not a confirmed violation.`,
          {
            humanRequestExcerpt: request.rawPrompt,
            agentIntentExcerpt: action,
            observedResource: action,
            verification: "inferred"
          }
        )
      );
    }

    const unacknowledged = this.unacknowledgedConstraints(analysis, intent);
    checks.push({ check: "constraint_not_acknowledged", passed: unacknowledged.length === 0 });
    for (const constraint of unacknowledged) {
      findings.push(
        finding(
          base,
          "spec_drift",
          "low",
          "Explicit user constraint not acknowledged in intent",
          `The human stated "${constraint.text}" but the declared intent lists no matching constraint. The plan does not contradict it; it simply does not restate it.`,
          {
            humanRequestExcerpt: constraint.excerpt ?? constraint.text,
            agentIntentExcerpt: intent.constraints.join("; ") || "(no constraints declared)",
            declaredResource: constraint.text,
            verification: "inferred"
          }
        )
      );
    }

    return { status: statusFor(findings), findings, checks };
  }

  private constraintViolations(
    analysis: RequestAnalysis,
    intent: AgentIntent
  ): Array<{ constraint: RequestStatement; resource: RequestResource; intentExcerpt: string; description: string }> {
    const violations: Array<{ constraint: RequestStatement; resource: RequestResource; intentExcerpt: string; description: string }> = [];
    const seen = new Set<string>();
    for (const resource of analysis.explicitlyForbiddenResources) {
      if (resource.provenance !== "explicit") continue;
      const constraint =
        analysis.explicitConstraints.find((item) => (item.excerpt ?? item.text) === resource.excerpt) ??
        analysis.explicitConstraints[0];
      if (!constraint) continue;
      for (const hit of intentMentions(resource.category, intent)) {
        const key = `${resource.category}:${hit.excerpt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          constraint,
          resource,
          intentExcerpt: hit.excerpt,
          description: `The human explicitly stated "${constraint.text}", but the agent's declared intent ${hit.reason}.`
        });
      }
    }
    return violations;
  }

  private missingObjectives(analysis: RequestAnalysis, intent: AgentIntent): RequestStatement[] {
    const intentWords = new Set(
      contentWords(
        [intent.goal, intent.interpretation, intent.summary, ...intent.plannedChanges, ...intent.expectedFiles, ...intent.expectedCommands].join(" ")
      )
    );
    return analysis.objectives.filter((objective) => {
      if (objective.provenance !== "explicit") return false;
      const words = contentWords(objective.text);
      if (!words.length) return false;
      const overlap = words.filter((word) => intentWords.has(word) || [...intentWords].some((candidate) => shareStem(word, candidate))).length;
      return overlap / words.length < OBJECTIVE_OVERLAP_THRESHOLD;
    });
  }

  private scopeExpansions(request: HumanRequest, analysis: RequestAnalysis, intent: AgentIntent): string[] {
    const requestWords = new Set(contentWords([request.rawPrompt, ...(request.requestedObjectives ?? []), ...analysis.objectives.map((item) => item.text)].join(" ")));
    return intent.plannedChanges.filter((action) => {
      if (!SCOPE_EXPANSION_VERBS.test(action)) return false;
      const words = contentWords(action).filter((word) => !SCOPE_EXPANSION_VERBS.test(word));
      return !words.some((word) => requestWords.has(word) || [...requestWords].some((candidate) => shareStem(word, candidate)));
    });
  }

  private unacknowledgedConstraints(analysis: RequestAnalysis, intent: AgentIntent): RequestStatement[] {
    const declared = intent.constraints.map((constraint) => new Set(contentWords(constraint)));
    return analysis.explicitConstraints.filter((constraint) => {
      const words = contentWords(constraint.text);
      if (!words.length) return false;
      return !declared.some((set) => words.filter((word) => set.has(word)).length / words.length >= 0.5);
    });
  }
}

function intentMentions(category: RequestResourceCategory, intent: AgentIntent): Array<{ excerpt: string; reason: string }> {
  const hits: Array<{ excerpt: string; reason: string }> = [];
  if (category === "dependencies" && intent.expectedDependencies.length) {
    hits.push({ excerpt: intent.expectedDependencies.join(", "), reason: `declares expected dependencies (${intent.expectedDependencies.join(", ")})` });
  }
  if (category === "network" && intent.expectedNetwork.length) {
    hits.push({ excerpt: intent.expectedNetwork.join(", "), reason: `declares expected network destinations (${intent.expectedNetwork.join(", ")})` });
  }
  if (category === "secrets" && intent.expectedSecrets.length) {
    hits.push({ excerpt: intent.expectedSecrets.join(", "), reason: `declares expected secret access (${intent.expectedSecrets.join(", ")})` });
  }
  const filePatterns = FILE_PATTERNS[category];
  if (filePatterns) {
    for (const file of intent.expectedFiles) {
      if (filePatterns.some((pattern) => pattern.test(file))) {
        hits.push({ excerpt: file, reason: `expects to change ${category} file "${file}"` });
      }
    }
  }
  if (category === "other" || category === "tests") return hits;
  const terms = RESOURCE_LEXICON[category];
  for (const text of [...intent.plannedChanges, intent.interpretation]) {
    if (isNegated(text)) continue;
    if (terms.some((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text)) && MUTATION_VERBS.test(text)) {
      hits.push({ excerpt: text, reason: `plans to "${text}"` });
    }
  }
  return hits;
}

export const FILE_PATTERNS: Partial<Record<RequestResourceCategory, RegExp[]>> = {
  infrastructure: INFRA_FILE_PATTERNS,
  database: DATABASE_FILE_PATTERNS,
  configuration: CONFIG_FILE_PATTERNS,
  secrets: SECRET_FILE_PATTERNS
};

const MUTATION_VERBS = /\b(modify|modifies|change|changes|update|updates|alter|alters|add|adds|remove|removes|delete|deletes|drop|drops|migrate|migrates|write|writes|edit|edits|create|creates|install|installs|rewrite|rewrites|touch)\b/i;

function isNegated(text: string): boolean {
  return /\b(do not|don'?t|without|avoid|never|no changes? to|not going to|will not|won'?t)\b/i.test(text);
}

function shareStem(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function statusFor(findings: FindingDraft[]): AlignmentStatus {
  if (findings.some((item) => item.severity === "high" || item.severity === "critical")) return "conflict";
  if (findings.length) return "warning";
  return "aligned";
}

function finding(
  base: { taskId: string; runId?: string; requestId: string; intentId: string },
  type: FindingDraft["type"],
  severity: EventSeverity,
  title: string,
  description: string,
  evidence: NonNullable<FindingDraft["evidence"]>
): FindingDraft {
  return {
    taskId: base.taskId,
    runId: base.runId,
    source: "request_intent_comparison",
    type,
    severity,
    title,
    description,
    evidence: { ...evidence, requestId: base.requestId, intentId: base.intentId }
  };
}
