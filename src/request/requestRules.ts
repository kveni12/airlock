import type { RequestResourceCategory } from "../types.js";

export type LexiconCategory = Exclude<RequestResourceCategory, "other">;

/** Editable rule set that drives the deterministic request analyzer. Patterns are JS regex sources, matched case-insensitively. */
export interface RequestAnalyzerRules {
  revision: number;
  updatedAt: string;
  /** A sentence matching any of these is recorded as an explicit constraint instead of an objective. */
  prohibitionPatterns: string[];
  /** Matches that flag a sentence as ambiguous; `label` is what the human sees. */
  hedgePatterns: Array<{ pattern: string; label: string }>;
  /** Leading verbs that let "do X and do Y" be split into two objectives. */
  imperativeVerbs: string[];
  /** Words/phrases that map a sentence to a resource category. */
  resourceLexicon: Record<LexiconCategory, string[]>;
  /** Extra expectations added when a sentence matches; `when` is a regex over the joined objectives. */
  inferredExpectations: Array<{ when: string; text: string }>;
}

export const LEXICON_CATEGORIES: LexiconCategory[] = ["database", "infrastructure", "dependencies", "network", "secrets", "tests", "configuration"];

export const DEFAULT_REQUEST_RULES: RequestAnalyzerRules = {
  revision: 0,
  updatedAt: "1970-01-01T00:00:00.000Z",
  prohibitionPatterns: [
    "\\bdo not\\b",
    "\\bdon'?t\\b",
    "\\bnever\\b",
    "\\bmust not\\b",
    "\\bmustn'?t\\b",
    "\\bshould not\\b",
    "\\bshouldn'?t\\b",
    "\\bavoid\\b",
    "\\bwithout (modifying|changing|touching|adding|removing|altering)\\b",
    "\\bno changes? to\\b",
    "\\bleave .* (alone|untouched|as[- ]is)\\b"
  ],
  hedgePatterns: [
    { pattern: "\\bmaybe\\b", label: "hedged wording (\"maybe\")" },
    { pattern: "\\bif (necessary|needed|possible)\\b", label: "conditional scope (\"if necessary\")" },
    { pattern: "\\bas needed\\b", label: "open-ended scope (\"as needed\")" },
    { pattern: "\\betc\\.?(\\s|$)", label: "open-ended list (\"etc\")" },
    { pattern: "\\b(something|anything|whatever|stuff|things)\\b", label: "vague object" },
    { pattern: "\\bor\\b", label: "alternatives joined by \"or\"" }
  ],
  imperativeVerbs: [
    "fix", "add", "remove", "update", "change", "implement", "create", "write", "refactor", "rename", "delete", "improve", "make", "build",
    "investigate", "debug", "resolve", "migrate", "upgrade", "document", "test", "run", "clean", "move", "replace", "support", "handle",
    "ensure", "prevent", "optimize", "reduce", "increase", "enable", "disable", "introduce", "extend", "expose", "wire", "configure", "install"
  ],
  resourceLexicon: {
    database: ["database", "databases", "db", "table", "tables", "schema", "schemas", "migration", "migrations", "sql"],
    infrastructure: ["infrastructure", "infra", "terraform", "kubernetes", "k8s", "helm", "docker", "dockerfile", "deployment", "deploy", "ci", "pipeline", "workflow", "workflows"],
    dependencies: ["dependency", "dependencies", "package", "packages", "library", "libraries", "npm install", "third-party"],
    network: ["network", "external service", "external services", "api call", "api calls", "http", "internet", "remote"],
    secrets: ["secret", "secrets", "credential", "credentials", "token", "tokens", "password", "passwords", "api key", "api keys"],
    tests: ["test", "tests", "spec", "specs", "regression test", "test suite"],
    configuration: ["config", "configuration", "configs", "settings", "environment variable", "environment variables", ".env"]
  },
  inferredExpectations: [
    { when: "\\b(test|tests|spec|specs|test suite)\\b", text: "Tests are expected to be executed" },
    { when: "\\b(fix|bug|regression|broken|fail)", text: "Existing behavior outside the bug should remain unchanged" },
    { when: ".", text: "Only the requested scope should change" }
  ]
};

export interface CompiledRules {
  rules: RequestAnalyzerRules;
  prohibitions: RegExp[];
  hedges: Array<{ pattern: RegExp; label: string }>;
  imperativeVerbs: Set<string>;
  lexicon: Array<{ category: LexiconCategory; term: string; pattern: RegExp }>;
  expectations: Array<{ when: RegExp; text: string }>;
}

export function compileRules(rules: RequestAnalyzerRules): CompiledRules {
  return {
    rules,
    prohibitions: rules.prohibitionPatterns.map((p) => new RegExp(p, "i")),
    hedges: rules.hedgePatterns.map((h) => ({ pattern: new RegExp(h.pattern, "i"), label: h.label })),
    imperativeVerbs: new Set(rules.imperativeVerbs.map((v) => v.toLowerCase())),
    lexicon: LEXICON_CATEGORIES.flatMap((category) =>
      (rules.resourceLexicon[category] ?? []).map((term) => ({
        category,
        term,
        pattern: new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i")
      }))
    ),
    expectations: rules.inferredExpectations.map((e) => ({ when: new RegExp(e.when, "i"), text: e.text }))
  };
}

/** Validates a rules payload from the API; every regex must compile. Revision/updatedAt are assigned by the caller. */
export function validateRules(value: unknown): Omit<RequestAnalyzerRules, "revision" | "updatedAt"> {
  if (!value || typeof value !== "object") throw new Error("rules must be an object");
  const r = value as Record<string, unknown>;
  const prohibitionPatterns = regexList(r.prohibitionPatterns, "prohibitionPatterns");
  const hedgePatterns = objectList(r.hedgePatterns, "hedgePatterns").map((h, i) => {
    const pattern = regexString(h.pattern, `hedgePatterns[${i}].pattern`);
    const label = typeof h.label === "string" && h.label.trim() ? h.label.trim() : pattern;
    return { pattern, label };
  });
  const imperativeVerbs = stringList(r.imperativeVerbs, "imperativeVerbs");
  const lexiconInput = r.resourceLexicon && typeof r.resourceLexicon === "object" ? (r.resourceLexicon as Record<string, unknown>) : {};
  const resourceLexicon = Object.fromEntries(
    LEXICON_CATEGORIES.map((category) => [category, stringList(lexiconInput[category] ?? [], `resourceLexicon.${category}`)])
  ) as Record<LexiconCategory, string[]>;
  const inferredExpectations = objectList(r.inferredExpectations, "inferredExpectations").map((e, i) => ({
    when: regexString(e.when, `inferredExpectations[${i}].when`),
    text: stringValue(e.text, `inferredExpectations[${i}].text`)
  }));
  return { prohibitionPatterns, hedgePatterns, imperativeVerbs, resourceLexicon, inferredExpectations };
}

function regexList(value: unknown, label: string): string[] {
  return stringList(value, label).map((p, i) => regexString(p, `${label}[${i}]`));
}

function regexString(value: unknown, label: string): string {
  const source = stringValue(value, label);
  try {
    new RegExp(source, "i");
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${(error as Error).message}`);
  }
  return source;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

function objectList(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object")) throw new Error(`${label} must be an array of objects`);
  return value as Array<Record<string, unknown>>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
