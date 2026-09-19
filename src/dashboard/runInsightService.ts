import { summarizeBehavior } from "../analysis/behaviorAnalyzer.js";
import { buildObservedBehavior, type ObservedBehavior } from "../analysis/observedBehavior.js";
import { JsonStore } from "../store/jsonStore.js";
import type {
  AgentEvent,
  AgentIntent,
  AlignmentSegment,
  AlignmentStatus,
  AlignmentSummary,
  EventSeverity,
  Finding,
  HumanRequest,
  PermissionSnapshot,
  RequestAnalysis,
  ResolutionAttempt,
  ResultSummary,
  Review,
  RunRecord,
  TimelineEntry
} from "../types.js";

export interface RunDetail {
  run: RunRecord;
  request?: HumanRequest;
  requestAnalysis?: RequestAnalysis;
  intent?: AgentIntent;
  permissions?: PermissionSnapshot;
  behaviorSummary?: ObservedBehavior;
  result: ResultSummary;
  alignment: AlignmentSummary;
  findings: Finding[];
  review?: Review;
  resolutions: ResolutionAttempt[];
}

interface RunContext {
  run: RunRecord;
  request?: HumanRequest;
  requestAnalysis?: RequestAnalysis;
  intent?: AgentIntent;
  permissions?: PermissionSnapshot;
  events: AgentEvent[];
  findings: Finding[];
  review?: Review;
  resolutions: ResolutionAttempt[];
}

/**
 * Composed, read-only views over canonical store state: alignment, result, timeline, run detail.
 * Nothing here is persisted; every value is derived from runs, events, findings, reviews, and resolutions.
 */
export class RunInsightService {
  constructor(private readonly store: JsonStore) {}

  async alignment(runId: string): Promise<AlignmentSummary> {
    return buildAlignment(await this.load(runId));
  }

  async result(runId: string): Promise<ResultSummary> {
    return buildResult(await this.load(runId));
  }

  async timeline(runId: string): Promise<TimelineEntry[]> {
    return buildTimeline(await this.load(runId));
  }

  async detail(runId: string): Promise<RunDetail> {
    const ctx = await this.load(runId);
    const behaviorSummary = ctx.intent ? buildObservedBehavior(ctx.run, ctx.events, summarizeBehavior(ctx.run, ctx.events)) : undefined;
    return {
      run: ctx.run,
      request: ctx.request,
      requestAnalysis: ctx.requestAnalysis,
      intent: ctx.intent,
      permissions: ctx.permissions,
      behaviorSummary,
      result: buildResult(ctx),
      alignment: buildAlignment(ctx),
      findings: ctx.findings,
      review: ctx.review,
      resolutions: ctx.resolutions
    };
  }

  private async load(runId: string): Promise<RunContext> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const [intent, request, permissions, events, allFindings, reviews, resolutions] = await Promise.all([
      run.intentId ? this.store.getIntent(run.intentId) : this.store.getIntentForRun(runId),
      run.requestId ? this.store.getRequest(run.requestId) : this.store.getRequestForRun(runId),
      this.store.getPermissions(runId),
      this.store.getEvents(runId),
      this.store.listFindings(),
      this.store.listReviews(),
      this.store.listResolutions()
    ]);
    const requestAnalysis = request ? await this.store.getRequestAnalysis(request.id) : undefined;
    const findings = allFindings.filter(
      (finding) => finding.runId === runId || (!finding.runId && intent?.alignment?.findingIds.includes(finding.id))
    );
    const review = reviews
      .filter((candidate) => candidate.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      run,
      request,
      requestAnalysis,
      intent,
      permissions,
      events,
      findings,
      review,
      resolutions: resolutions.filter((attempt) => attempt.originalRunId === runId)
    };
  }
}

const RANK: Record<EventSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function statusFor(findings: Finding[]): AlignmentStatus {
  const active = findings.filter((finding) => finding.status !== "dismissed");
  if (active.some((finding) => RANK[finding.severity] >= RANK.high)) return "conflict";
  if (active.some((finding) => RANK[finding.severity] >= RANK.low)) return "warning";
  return "aligned";
}

export function buildAlignment(ctx: RunContext): AlignmentSummary {
  const { run, intent, findings, review } = ctx;
  const requestFindings = findings.filter((finding) => finding.source === "request_intent_comparison");
  const behaviorFindings = findings.filter((finding) => finding.source === "intent_comparison");
  const reviewFindings = findings.filter((finding) => finding.source === "reviewer" || finding.source === "policy");

  let requestToIntent: AlignmentSegment;
  if (!intent) {
    requestToIntent = { status: "warning", findingIds: [], detail: "No intent is attached to this run; request → intent alignment could not be evaluated." };
  } else if (!intent.requestId) {
    requestToIntent = { status: "warning", findingIds: [], detail: "Intent is not linked to a human request; request → intent alignment could not be evaluated." };
  } else if (!intent.alignment) {
    requestToIntent = { status: "warning", findingIds: [], detail: "Request → intent analysis has not run yet." };
  } else {
    const ids = intent.alignment.findingIds.length ? intent.alignment.findingIds : requestFindings.map((finding) => finding.id);
    requestToIntent = {
      status: intent.alignment.status,
      findingIds: ids,
      detail: ids.length ? `${ids.length} request/intent finding(s)` : "Declared intent is consistent with the human request."
    };
  }

  let intentToBehavior: AlignmentSegment;
  if (!intent) {
    intentToBehavior = { status: "warning", findingIds: [], detail: "No intent to compare observed behavior against." };
  } else if (!run.gitSummary && !["completed", "failed", "stopped"].includes(run.status)) {
    intentToBehavior = { status: "aligned", findingIds: behaviorFindings.map((f) => f.id), detail: "Run has not finished; behavior comparison is partial." };
  } else {
    const deviationFindings = behaviorFindings.filter((finding) => finding.type !== "missing_action" && finding.status !== "dismissed");
    const deviations = deviationFindings.length;
    const resolved = deviationFindings.filter((finding) => finding.status === "resolved").length;
    intentToBehavior = {
      status: statusFor(behaviorFindings),
      findingIds: behaviorFindings.map((finding) => finding.id),
      detail: deviations
        ? `${deviations} undeclared behavior(s) detected${resolved ? ` (${resolved} resolved)` : ""}`
        : "Observed behavior matched the declared intent within available telemetry."
    };
  }

  let behaviorToResult: AlignmentSegment | undefined;
  if (review) {
    const openReview = reviewFindings.filter((finding) => finding.status !== "resolved" && finding.status !== "dismissed");
    const status: AlignmentStatus = review.status === "failed" ? "conflict" : openReview.length ? statusFor(openReview) : "aligned";
    behaviorToResult = {
      status: status === "aligned" && review.status !== "approved" && review.filesReviewed < review.filesTotal ? "warning" : status,
      findingIds: reviewFindings.map((finding) => finding.id),
      detail: `${review.filesReviewed}/${review.filesTotal} files reviewed, ${reviewFindings.length} finding(s), ${openReview.length} unresolved`
    };
  }

  const active = behaviorFindings.filter((finding) => finding.status !== "dismissed");
  return {
    runId: run.id,
    requestId: run.requestId ?? intent?.requestId,
    intentId: intent?.id,
    requestToIntent,
    intentToBehavior,
    behaviorToResult,
    counts: {
      undeclaredFiles: active.filter((finding) => finding.type === "spec_drift").length,
      undeclaredDependencies: active.filter((finding) => finding.type === "dependency").length,
      undeclaredNetworkDestinations: active.filter((finding) => finding.type === "network").length,
      undeclaredTools: active.filter((finding) => finding.type === "permission").length,
      missingExpectedActions: active.filter((finding) => finding.type === "missing_action").length
    }
  };
}

export function buildResult(ctx: RunContext): ResultSummary {
  const { run, events, findings, review } = ctx;
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const summary = summarizeBehavior(run, events);
  const runFindings = findings.filter((finding) => finding.runId === run.id);
  return {
    runId: run.id,
    status: run.status,
    exitCode: run.exitCode,
    failureReason: run.failureReason,
    filesChanged: run.gitSummary?.files ?? [],
    insertions: run.gitSummary?.insertions ?? 0,
    deletions: run.gitSummary?.deletions ?? 0,
    dependenciesChanged: run.gitSummary?.dependencyChanges ?? [],
    commits: run.gitSummary?.commits ?? [],
    tests: summary.tests.map((test) => ({
      ...test,
      verification: test.eventIds.some((id) => eventsById.get(id)?.verification === "independent") ? "independent" : "agent_reported"
    })),
    review: review
      ? {
          reviewId: review.id,
          status: review.status,
          filesTotal: review.filesTotal,
          filesReviewed: review.filesReviewed,
          filesWithFindings: review.filesWithFindings,
          findingIds: review.findingIds,
          approvedAt: review.approvedAt,
          approval: review.approval
        }
      : undefined,
    findings: {
      total: runFindings.length,
      open: runFindings.filter((finding) => ["open", "resolving", "re_reviewing"].includes(finding.status)).length,
      resolved: runFindings.filter((finding) => finding.status === "resolved").length,
      dismissed: runFindings.filter((finding) => finding.status === "dismissed").length
    },
    approvalStatus: !review ? "not_reviewed" : review.status === "approved" ? "approved" : review.status === "needs_human" ? "needs_human" : "pending"
  };
}

export function buildTimeline(ctx: RunContext): TimelineEntry[] {
  const { run, request, requestAnalysis, intent, events, findings, review, resolutions } = ctx;
  const entries: TimelineEntry[] = [];

  if (request) {
    entries.push({
      id: `tl_${request.id}`,
      timestamp: request.createdAt,
      kind: "human.request",
      actor: "human",
      title: "Human request",
      detail: request.rawPrompt,
      verification: "independent",
      refs: { requestId: request.id }
    });
  }
  if (requestAnalysis) {
    entries.push({
      id: `tl_${requestAnalysis.id}`,
      timestamp: requestAnalysis.createdAt,
      kind: "request.analysis",
      actor: "agentguard",
      title: "Request analyzed",
      detail: `${requestAnalysis.objectives.length} objective(s), ${requestAnalysis.explicitConstraints.length} explicit constraint(s), ${requestAnalysis.explicitlyForbiddenResources.length} forbidden resource(s), ${requestAnalysis.ambiguities.length} ambiguity(ies)`,
      verification: "inferred",
      refs: { requestId: requestAnalysis.requestId }
    });
  }
  if (intent) {
    entries.push({
      id: `tl_${intent.id}`,
      timestamp: intent.createdAt,
      kind: "agent.intent",
      actor: "agent",
      title: "Agent declared intent",
      detail: `${intent.plannedActions.length} planned action(s); goal: ${intent.goal}`,
      evidenceSource: "agent_reported",
      verification: "agent_reported",
      refs: { intentId: intent.id, requestId: intent.requestId, runId: intent.planningRunId }
    });
    if (intent.alignment) {
      entries.push({
        id: `tl_${intent.id}_alignment`,
        timestamp: intent.alignment.analyzedAt,
        kind: "intent.analysis",
        actor: "agentguard",
        title: `Request → Intent ${intent.alignment.status}`,
        detail: intent.alignment.findingIds.length ? `${intent.alignment.findingIds.length} pre-execution finding(s)` : "No request/intent discrepancies",
        verification: "inferred",
        refs: { intentId: intent.id, requestId: intent.requestId, findingIds: intent.alignment.findingIds }
      });
    }
    if (intent.approval) {
      entries.push({
        id: `tl_${intent.id}_approval`,
        timestamp: intent.approval.at,
        kind: "intent.approval",
        actor: "human",
        title: `Intent ${intent.approval.status}`,
        detail: intent.approval.reason,
        refs: { intentId: intent.id }
      });
    }
  }

  for (const event of events) {
    const entry = eventEntry(event);
    if (entry) entries.push(entry);
  }

  for (const finding of findings) {
    entries.push({
      id: `tl_${finding.id}`,
      timestamp: finding.createdAt,
      kind: "finding.created",
      actor: finding.source === "reviewer" ? "reviewer" : "agentguard",
      title: finding.title,
      detail: finding.description,
      severity: finding.severity,
      verification: finding.evidence?.verification,
      refs: {
        findingId: finding.id,
        requestId: finding.evidence?.requestId,
        intentId: finding.evidence?.intentId,
        reviewId: finding.reviewId,
        runId: finding.runId
      }
    });
  }

  if (review) {
    entries.push({
      id: `tl_${review.id}`,
      timestamp: review.createdAt,
      kind: "review",
      actor: "reviewer",
      title: "Review started",
      refs: { reviewId: review.id }
    });
    if (review.completedAt) {
      entries.push({
        id: `tl_${review.id}_completed`,
        timestamp: review.completedAt,
        kind: "review",
        actor: "reviewer",
        title: `Review ${review.status === "failed" ? "failed" : "completed"}`,
        detail: `${review.filesReviewed}/${review.filesTotal} files reviewed, ${review.findingIds.length} finding(s)`,
        evidenceSource: "reviewer",
        verification: "inferred",
        refs: { reviewId: review.id, findingIds: review.findingIds }
      });
    }
    if (review.approvedAt) {
      entries.push({
        id: `tl_${review.id}_approved`,
        timestamp: review.approvedAt,
        kind: "approval",
        actor: "human",
        title: "Review approved",
        detail: review.approval?.reason,
        refs: { reviewId: review.id }
      });
    }
  }

  for (const attempt of resolutions) {
    entries.push({
      id: `tl_${attempt.id}`,
      timestamp: attempt.createdAt,
      kind: "resolution",
      actor: "resolver",
      title: "Resolution started",
      refs: { resolutionId: attempt.id, findingId: attempt.findingId, runId: attempt.resolutionRunId }
    });
    if (attempt.completedAt) {
      entries.push({
        id: `tl_${attempt.id}_completed`,
        timestamp: attempt.completedAt,
        kind: "resolution",
        actor: "resolver",
        title: `Resolution ${attempt.status}`,
        detail: attempt.reReviewResult?.summary ?? attempt.failureReason,
        severity: attempt.status === "resolved" ? "info" : "medium",
        refs: { resolutionId: attempt.id, findingId: attempt.findingId, runId: attempt.resolutionRunId, reviewId: attempt.reviewId }
      });
    }
  }

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

function eventEntry(event: AgentEvent): TimelineEntry | undefined {
  const base = {
    id: `tl_${event.id}`,
    timestamp: event.timestamp,
    severity: event.severity,
    evidenceSource: event.evidenceSource,
    verification: event.verification,
    refs: { eventId: event.id, runId: event.runId }
  };
  const resource = event.resource ?? "";
  switch (event.category) {
    case "runtime":
      if (event.action.startsWith("review_") || event.action.startsWith("resolution_")) return undefined;
      return { ...base, kind: "runtime", actor: "runtime", title: `Sandbox ${event.action.replace(/_/g, " ")}`, detail: resource || undefined };
    case "filesystem":
      return { ...base, kind: "filesystem", actor: "agent", title: `File ${event.action}`, detail: resource };
    case "process":
      if (event.action === "start") return undefined;
      return { ...base, kind: "process", actor: "agent", title: event.action === "command_start" ? "Command" : `Process ${event.action.replace(/_/g, " ")}`, detail: resource || undefined };
    case "network":
      return { ...base, kind: "network", actor: "agent", title: event.allowed === false ? "Network request blocked" : "Network request", detail: resource };
    case "mcp":
      return { ...base, kind: "mcp", actor: "agent", title: `MCP ${event.action.replace(/_/g, " ")}`, detail: resource };
    case "git":
      return {
        ...base,
        kind: "git",
        actor: "agent",
        title: event.action === "dependency_added" ? "Dependency added" : event.action === "dependency_removed" ? "Dependency removed" : `Git ${event.action.replace(/_/g, " ")}`,
        detail: resource
      };
    case "policy":
      return { ...base, kind: "policy", actor: "agentguard", title: `Policy ${event.action.replace(/_/g, " ")}`, detail: resource || undefined };
    case "agent":
      return { ...base, kind: "agent", actor: "agent", title: `Agent ${event.action.replace(/_/g, " ")}`, detail: resource || undefined };
    case "secret":
      return { ...base, kind: "policy", actor: "agentguard", title: `Secret ${event.action.replace(/_/g, " ")}`, detail: resource || undefined };
    default:
      return undefined;
  }
}
