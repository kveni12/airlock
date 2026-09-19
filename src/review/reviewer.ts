import type {
  AgentIntent,
  BehaviorSummary,
  EventSeverity,
  Finding,
  FindingType,
  GitSummary,
  PermissionSnapshot
} from "../types.js";

export interface ReviewerInput {
  task: { taskId: string; runId: string; builderAgentId: string };
  intent: AgentIntent;
  permissions: PermissionSnapshot;
  behavior: BehaviorSummary;
  git: Pick<GitSummary, "files" | "filesChanged" | "insertions" | "deletions" | "dependencyChanges" | "diff">;
  tests: BehaviorSummary["tests"];
  deterministicFindings: Finding[];
}

export interface ReviewerFindingOutput {
  type: FindingType;
  severity: EventSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidenceEventIds: string[];
  suggestedFix?: string;
}

export interface ReviewerOutput {
  summary: string;
  verdict: "needs_human" | "approve";
  reviewedFiles: string[];
  findings: ReviewerFindingOutput[];
}

export interface Reviewer {
  readonly id: string;
  review(input: ReviewerInput): Promise<ReviewerOutput>;
}

export class DeterministicReviewer implements Reviewer {
  readonly id = "agentguard-deterministic-reviewer";

  async review(input: ReviewerInput): Promise<ReviewerOutput> {
    const actionable = input.deterministicFindings.filter(
      (finding) => finding.status === "open" && finding.severity !== "info"
    );
    return {
      summary: actionable.length
        ? `Reviewed ${input.git.files.length} changed files. ${actionable.length} deterministic finding(s) require human attention.`
        : `Reviewed ${input.git.files.length} changed files with no actionable deterministic findings.`,
      verdict: actionable.length ? "needs_human" : "approve",
      reviewedFiles: [...input.git.files],
      findings: []
    };
  }
}

export class StructuredOutputReviewer implements Reviewer {
  constructor(
    readonly id: string,
    private readonly output: unknown
  ) {}

  async review(input: ReviewerInput): Promise<ReviewerOutput> {
    return parseReviewerOutput(this.output, input.git.files);
  }
}

export function parseReviewerOutput(output: unknown, changedFiles: string[]): ReviewerOutput {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Reviewer output is not valid JSON");
    }
  }
  const record = objectValue(value);
  if (!record) throw new Error("Reviewer output must be an object");
  const summary = requiredString(record.summary, "reviewer.summary");
  const verdict = record.verdict;
  if (verdict !== "needs_human" && verdict !== "approve") {
    throw new Error("reviewer.verdict must be needs_human or approve");
  }
  const reviewedFiles = stringArray(record.reviewedFiles, "reviewer.reviewedFiles");
  const changed = new Set(changedFiles);
  for (const file of reviewedFiles) {
    if (!changed.has(file)) throw new Error(`Reviewer marked unchanged file as reviewed: ${file}`);
  }

  if (!Array.isArray(record.findings)) throw new Error("reviewer.findings must be an array");
  const findings = record.findings.map((item, index) => parseFinding(item, index, changed));
  return { summary, verdict, reviewedFiles: [...new Set(reviewedFiles)], findings };
}

function parseFinding(value: unknown, index: number, changedFiles: Set<string>): ReviewerFindingOutput {
  const record = objectValue(value);
  if (!record) throw new Error(`reviewer.findings[${index}] must be an object`);
  const allowedTypes: FindingType[] = [
    "security",
    "spec_drift",
    "permission",
    "network",
    "dependency",
    "tests",
    "code_quality",
    "sensitive_change",
    "other"
  ];
  const allowedSeverities: EventSeverity[] = ["info", "low", "medium", "high", "critical"];
  if (!allowedTypes.includes(record.type as FindingType)) throw new Error(`Invalid reviewer finding type at index ${index}`);
  if (!allowedSeverities.includes(record.severity as EventSeverity)) {
    throw new Error(`Invalid reviewer finding severity at index ${index}`);
  }
  const file = optionalString(record.file);
  if (file && !changedFiles.has(file)) throw new Error(`Reviewer finding references unchanged file: ${file}`);
  const line = record.line === undefined ? undefined : Number(record.line);
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error(`Invalid reviewer finding line at index ${index}`);
  return {
    type: record.type as FindingType,
    severity: record.severity as EventSeverity,
    title: requiredString(record.title, `reviewer.findings[${index}].title`),
    description: requiredString(record.description, `reviewer.findings[${index}].description`),
    file,
    line,
    evidenceEventIds: stringArray(record.evidenceEventIds, `reviewer.findings[${index}].evidenceEventIds`),
    suggestedFix: optionalString(record.suggestedFix)
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}
