import { createId } from "../utils/id.js";
import { DEFAULT_REQUEST_RULES, compileRules, type CompiledRules, type RequestAnalyzerRules } from "./requestRules.js";
import type {
  HumanRequest,
  RequestAnalysis,
  RequestResource,
  RequestStatement
} from "../types.js";

/** Default lexicon, kept for callers that only need the built-in categories. */
export const RESOURCE_LEXICON = DEFAULT_REQUEST_RULES.resourceLexicon;

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

const DEFAULT_COMPILED = compileRules(DEFAULT_REQUEST_RULES);

export class RequestAnalyzer {
  /** `rules` may be a function so edits made through the API take effect on the next analysis. */
  constructor(private readonly rules: RequestAnalyzerRules | (() => RequestAnalyzerRules) = DEFAULT_REQUEST_RULES) {}

  analyze(request: HumanRequest): RequestAnalysis {
    return this.analyzeWith(request, compileRules(typeof this.rules === "function" ? this.rules() : this.rules));
  }

  analyzeWith(request: HumanRequest, compiled: CompiledRules): RequestAnalysis {
    const manual = request.analysisMode === "manual";
    const sentences = splitSentences(request.rawPrompt);
    const objectives: RequestStatement[] = [];
    const explicitConstraints: RequestStatement[] = [];
    const ambiguities: string[] = [];

    for (const sentence of sentences) {
      if (manual) {
        for (const hedge of compiled.hedges) {
          if (hedge.pattern.test(sentence)) ambiguities.push(`${hedge.label}: "${sentence}"`);
        }
      } else if (isProhibition(sentence, compiled)) {
        explicitConstraints.push({ text: normalizeConstraint(sentence), provenance: "explicit", source: "prompt", excerpt: sentence });
      } else {
        for (const part of splitCompoundObjective(sentence, compiled)) {
          objectives.push({ text: stripTerminalPunctuation(part), provenance: "explicit", source: "prompt", excerpt: sentence });
        }
        for (const hedge of compiled.hedges) {
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
      explicitConstraints.flatMap((constraint) => extractResources(constraint.excerpt ?? constraint.text, compiled))
    );
    const explicitlyRequestedResources = uniqueResources(
      objectives.flatMap((objective) => extractResources(objective.excerpt ?? objective.text, compiled))
    );

    return {
      id: createId("reqan"),
      requestId: request.id,
      objectives,
      explicitConstraints,
      inferredExpectations: inferExpectations(objectives, compiled),
      explicitlyRequestedResources,
      explicitlyForbiddenResources,
      ambiguities,
      analyzer: "deterministic",
      rulesRevision: compiled.rules.revision,
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

export function isProhibition(sentence: string, compiled: CompiledRules = DEFAULT_COMPILED): boolean {
  return compiled.prohibitions.some((pattern) => pattern.test(sentence));
}

export function extractResources(text: string, compiled: CompiledRules = DEFAULT_COMPILED): RequestResource[] {
  const resources: RequestResource[] = [];
  for (const entry of compiled.lexicon) {
    if (entry.pattern.test(text)) {
      resources.push({ resource: entry.term, category: entry.category, provenance: "explicit", excerpt: text });
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

function inferExpectations(objectives: RequestStatement[], compiled: CompiledRules): RequestStatement[] {
  if (!objectives.length) return [];
  const text = objectives.map((objective) => objective.text.toLowerCase()).join(" ");
  return compiled.expectations
    .filter((expectation) => expectation.when.test(text))
    .map((expectation) => ({ text: expectation.text, provenance: "inferred" as const, source: "analyzer" as const }));
}

function splitCompoundObjective(sentence: string, compiled: CompiledRules): string[] {
  const parts = sentence.split(/\s+and\s+/i);
  if (parts.length < 2) return [sentence];
  const allImperative = parts.every((part) => compiled.imperativeVerbs.has(part.trim().split(/\s+/)[0]?.toLowerCase() ?? ""));
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

