import { createId } from "../utils/id.js";
import type {
  HumanRequest,
  RequestAnalysis,
  RequestResource,
  RequestResourceCategory,
  RequestStatement
} from "../types.js";

export const RESOURCE_LEXICON: Record<Exclude<RequestResourceCategory, "other">, string[]> = {
  database: ["database", "databases", "db", "table", "tables", "schema", "schemas", "migration", "migrations", "sql"],
  infrastructure: [
    "infrastructure",
    "infra",
    "terraform",
    "kubernetes",
    "k8s",
    "helm",
    "docker",
    "dockerfile",
    "deployment",
    "deploy",
    "ci",
    "pipeline",
    "workflow",
    "workflows"
  ],
  dependencies: ["dependency", "dependencies", "package", "packages", "library", "libraries", "npm install", "third-party"],
  network: ["network", "external service", "external services", "api call", "api calls", "http", "internet", "remote"],
  secrets: ["secret", "secrets", "credential", "credentials", "token", "tokens", "password", "passwords", "api key", "api keys"],
  tests: ["test", "tests", "spec", "specs", "regression test", "test suite"],
  configuration: ["config", "configuration", "configs", "settings", "environment variable", "environment variables", ".env"]
};

const PROHIBITION_PATTERNS = [
  /\bdo not\b/i,
  /\bdon'?t\b/i,
  /\bnever\b/i,
  /\bmust not\b/i,
  /\bmustn'?t\b/i,
  /\bshould not\b/i,
  /\bshouldn'?t\b/i,
  /\bavoid\b/i,
  /\bwithout (modifying|changing|touching|adding|removing|altering)\b/i,
  /\bno changes? to\b/i,
  /\bleave .* (alone|untouched|as[- ]is)\b/i
];

const HEDGE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bmaybe\b/i, label: "hedged wording (\"maybe\")" },
  { pattern: /\bif (necessary|needed|possible)\b/i, label: "conditional scope (\"if necessary\")" },
  { pattern: /\bas needed\b/i, label: "open-ended scope (\"as needed\")" },
  { pattern: /\betc\.?(\s|$)/i, label: "open-ended list (\"etc\")" },
  { pattern: /\b(something|anything|whatever|stuff|things)\b/i, label: "vague object" },
  { pattern: /\bor\b/i, label: "alternatives joined by \"or\"" }
];

const IMPERATIVE_VERBS = [
  "fix",
  "add",
  "remove",
  "update",
  "change",
  "implement",
  "create",
  "write",
  "refactor",
  "rename",
  "delete",
  "improve",
  "make",
  "build",
  "investigate",
  "debug",
  "resolve",
  "migrate",
  "upgrade",
  "document",
  "test",
  "run",
  "clean",
  "move",
  "replace",
  "support",
  "handle",
  "ensure",
  "prevent",
  "optimize",
  "reduce",
  "increase",
  "enable",
  "disable",
  "introduce",
  "extend",
  "expose",
  "wire",
  "configure",
  "install"
];

export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "by",
  "at",
  "from",
  "is",
  "are",
  "be",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "please",
  "do",
  "not",
  "don't",
  "dont",
  "any",
  "some",
  "should",
  "must",
  "will",
  "can",
  "as",
  "so",
  "if",
  "then",
  "than",
  "into",
  "our",
  "your",
  "we",
  "you",
  "i",
  "also"
]);

export class RequestAnalyzer {
  analyze(request: HumanRequest): RequestAnalysis {
    const sentences = splitSentences(request.rawPrompt);
    const objectives: RequestStatement[] = [];
    const explicitConstraints: RequestStatement[] = [];
    const ambiguities: string[] = [];

    for (const sentence of sentences) {
      if (isProhibition(sentence)) {
        explicitConstraints.push({ text: normalizeConstraint(sentence), provenance: "explicit", source: "prompt", excerpt: sentence });
      } else {
        for (const part of splitCompoundObjective(sentence)) {
          objectives.push({ text: stripTerminalPunctuation(part), provenance: "explicit", source: "prompt", excerpt: sentence });
        }
        for (const hedge of HEDGE_PATTERNS) {
          if (hedge.pattern.test(sentence)) ambiguities.push(`${hedge.label}: "${sentence}"`);
        }
      }
    }

    for (const objective of request.requestedObjectives ?? []) {
      if (objective.trim()) objectives.push({ text: objective.trim(), provenance: "explicit", source: "caller" });
    }
    for (const constraint of request.explicitConstraints ?? []) {
      if (constraint.trim()) explicitConstraints.push({ text: constraint.trim(), provenance: "explicit", source: "caller" });
    }

    if (!objectives.length) ambiguities.push("no explicit objective could be identified in the request");

    const explicitlyForbiddenResources = uniqueResources(
      explicitConstraints.flatMap((constraint) => extractResources(constraint.excerpt ?? constraint.text))
    );
    const explicitlyRequestedResources = uniqueResources(
      objectives.flatMap((objective) => extractResources(objective.excerpt ?? objective.text))
    );

    return {
      id: createId("reqan"),
      requestId: request.id,
      objectives,
      explicitConstraints,
      inferredExpectations: inferExpectations(objectives, explicitlyRequestedResources),
      explicitlyRequestedResources,
      explicitlyForbiddenResources,
      ambiguities,
      analyzer: "deterministic",
      createdAt: new Date().toISOString()
    };
  }
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function isProhibition(sentence: string): boolean {
  return PROHIBITION_PATTERNS.some((pattern) => pattern.test(sentence));
}

export function extractResources(text: string): RequestResource[] {
  const lowered = text.toLowerCase();
  const resources: RequestResource[] = [];
  for (const [category, terms] of Object.entries(RESOURCE_LEXICON) as Array<[RequestResourceCategory, string[]]>) {
    for (const term of terms) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(lowered)) {
        resources.push({ resource: term, category, provenance: "explicit", excerpt: text });
      }
    }
  }
  return resources;
}

export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/._\-\s]/g, " ")
    .split(/\s+/)
    .map(stem)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/i, (match, _group, offset) => (offset > 3 ? "" : match));
}

function inferExpectations(objectives: RequestStatement[], requested: RequestResource[]): RequestStatement[] {
  const expectations: RequestStatement[] = [];
  const text = objectives.map((objective) => objective.text.toLowerCase()).join(" ");
  if (requested.some((resource) => resource.category === "tests")) {
    expectations.push({ text: "Tests are expected to be executed", provenance: "inferred", source: "analyzer" });
  }
  if (/\b(fix|bug|regression|broken|fail)/.test(text)) {
    expectations.push({ text: "Existing behavior outside the bug should remain unchanged", provenance: "inferred", source: "analyzer" });
  }
  if (objectives.length) {
    expectations.push({ text: "Only the requested scope should change", provenance: "inferred", source: "analyzer" });
  }
  return expectations;
}

function splitCompoundObjective(sentence: string): string[] {
  const parts = sentence.split(/\s+and\s+/i);
  if (parts.length < 2) return [sentence];
  const allImperative = parts.every((part) => IMPERATIVE_VERBS.includes(part.trim().split(/\s+/)[0]?.toLowerCase() ?? ""));
  return allImperative ? parts.map((part) => part.trim()) : [sentence];
}

function normalizeConstraint(sentence: string): string {
  return stripTerminalPunctuation(sentence)
    .replace(/\bdon'?t\b/i, "Do not")
    .replace(/\bmustn'?t\b/i, "Must not")
    .replace(/\bshouldn'?t\b/i, "Should not")
    .replace(/^please\s+/i, "");
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "").trim();
}

function uniqueResources(resources: RequestResource[]): RequestResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.category}:${resource.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
