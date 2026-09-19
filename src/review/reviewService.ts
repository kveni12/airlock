import type { FileReview, Finding, Review, RunRecord } from "../types.js";
import { BehaviorAnalysisService } from "../analysis/behaviorAnalyzer.js";
import { EventCollector } from "../events/eventCollector.js";
import { FindingService } from "../findings/findingService.js";
import { JsonStore } from "../store/jsonStore.js";
import { createId } from "../utils/id.js";
import { DeterministicReviewer, type Reviewer, type ReviewerInput, StructuredOutputReviewer } from "./reviewer.js";

export interface CreateReviewOptions {
  reviewerAgentId?: string;
  structuredOutput?: unknown;
}

export class ReviewService {
  constructor(
    private readonly store: JsonStore,
    private readonly events: EventCollector,
    private readonly findings: FindingService,
    private readonly analysis: BehaviorAnalysisService
  ) {}

  async create(runId: string, options: CreateReviewOptions = {}): Promise<Review> {
    const run = await this.requireCompletedRun(runId);
    const intent = run.intentId ? await this.store.getIntent(run.intentId) : await this.store.getIntentForRun(runId);
    if (!intent) throw new Error("A persisted intent is required before review");
    const changedFiles = run.gitSummary?.files ?? [];
    const reviewer: Reviewer = options.structuredOutput !== undefined
      ? new StructuredOutputReviewer(options.reviewerAgentId ?? "external-structured-reviewer", options.structuredOutput)
      : new DeterministicReviewer();

    const review: Review = {
      id: createId("review"),
      taskId: run.taskId,
      runId,
      builderAgentId: run.agentId,
      reviewerAgentId: reviewer.id,
      status: "reviewing",
      filesTotal: changedFiles.length,
      filesReviewed: 0,
      cleanFiles: 0,
      filesWithFindings: 0,
      fileReviews: changedFiles.map((path) => ({ path, status: "pending", findingIds: [] })),
      findingIds: [],
      createdAt: new Date().toISOString()
    };
    await this.store.createReview(review);
    await this.events.emitEvent(reviewEvent(run, review.id, "started"));

    try {
      const behavior = await this.analysis.analyzeRun(runId);
      await this.findings.flush();
      const deterministicFindings = await this.findings.list({ runId });
      const permissions = (await this.store.getPermissions(runId)) ?? {};
      const input: ReviewerInput = {
        task: { taskId: run.taskId, runId, builderAgentId: run.agentId },
        intent,
        permissions,
        behavior: behavior.summary,
        git: {
          files: changedFiles,
          filesChanged: run.gitSummary?.filesChanged ?? 0,
          insertions: run.gitSummary?.insertions ?? 0,
          deletions: run.gitSummary?.deletions ?? 0,
          dependencyChanges: run.gitSummary?.dependencyChanges ?? [],
          diff: (run.gitSummary?.diff ?? "").slice(0, 100_000)
        },
        tests: behavior.summary.tests,
        deterministicFindings
      };
      const output = await reviewer.review(input);
      const reviewerFindings: Finding[] = [];
      for (const item of output.findings) {
        reviewerFindings.push(
          await this.findings.create({
            taskId: run.taskId,
            runId,
            reviewId: review.id,
            source: "reviewer",
            type: item.type,
            severity: item.severity,
            title: item.title,
            description: item.suggestedFix ? `${item.description} Suggested fix: ${item.suggestedFix}` : item.description,
            file: item.file,
            line: item.line,
            evidence: { eventIds: item.evidenceEventIds }
          })
        );
      }
      const allFindings = [...deterministicFindings, ...reviewerFindings];
      const fileReviews = buildFileReviews(changedFiles, output.reviewedFiles, allFindings);
      const updated = await this.store.updateReview(review.id, {
        status: "needs_human",
        summary: output.summary,
        fileReviews,
        findingIds: allFindings.map((finding) => finding.id),
        filesReviewed: fileReviews.filter((file) => file.status !== "pending").length,
        cleanFiles: fileReviews.filter((file) => file.status === "clean").length,
        filesWithFindings: fileReviews.filter((file) => file.status === "finding").length,
        completedAt: new Date().toISOString()
      });
      await this.events.emitEvent(reviewEvent(run, review.id, "completed", { verdict: output.verdict }));
      return updated as Review;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.updateReview(review.id, {
        status: "failed",
        failureReason: message,
        completedAt: new Date().toISOString()
      });
      await this.events.emitEvent(reviewEvent(run, review.id, "reviewer_failed", { reason: message }, "medium"));
      return failed as Review;
    }
  }

  async approve(reviewId: string, approval: { actor?: string; reason?: string }): Promise<Review> {
    const review = await this.store.getReview(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    if (review.status !== "needs_human") throw new Error(`Review in status '${review.status}' cannot be approved`);
    const approved = await this.store.updateReview(reviewId, {
      status: "approved",
      approvedAt: new Date().toISOString(),
      approval
    });
    const run = await this.store.getRun(review.runId);
    if (run) await this.events.emitEvent(reviewEvent(run, review.id, "approved", approval));
    return approved as Review;
  }

  private async requireCompletedRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.gitSummary || !["completed", "failed"].includes(run.status)) {
      throw new Error("Run must be complete before review");
    }
    return run;
  }
}

function buildFileReviews(changedFiles: string[], reviewedFiles: string[], findings: Finding[]): FileReview[] {
  const reviewed = new Set(reviewedFiles);
  return changedFiles.map((path) => {
    if (!reviewed.has(path)) return { path, status: "pending", findingIds: [] };
    const findingIds = findings
      .filter((finding) => finding.file === path && !["dismissed", "resolved"].includes(finding.status))
      .map((finding) => finding.id);
    return { path, status: findingIds.length ? "finding" : "clean", findingIds };
  });
}

function reviewEvent(
  run: RunRecord,
  reviewId: string,
  action: string,
  metadata: Record<string, unknown> = {},
  severity: "info" | "medium" = "info"
) {
  return {
    runId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    category: "runtime" as const,
    action: `review_${action}`,
    severity,
    evidenceSource: "reviewer" as const,
    verification: "inferred" as const,
    correlationId: reviewId,
    metadata: { reviewId, ...metadata }
  };
}
