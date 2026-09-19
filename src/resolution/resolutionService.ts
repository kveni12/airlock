import path from "node:path";
import type { AgentProfile, CreateRunRequest, Finding, ResolutionAttempt } from "../types.js";
import { BehaviorAnalysisService } from "../analysis/behaviorAnalyzer.js";
import { EventCollector } from "../events/eventCollector.js";
import { FindingService } from "../findings/findingService.js";
import { ReviewService } from "../review/reviewService.js";
import { RuntimeManager } from "../runtime/runtimeManager.js";
import { JsonStore } from "../store/jsonStore.js";
import { createId } from "../utils/id.js";

export interface ResolveFindingRequest {
  resolverAgentId?: string;
  agent?: AgentProfile;
  command?: string[];
  strategy?: "revert_file";
  testCommand?: string[];
}

export class ResolutionService {
  constructor(
    private readonly store: JsonStore,
    private readonly events: EventCollector,
    private readonly runtime: RuntimeManager,
    private readonly findings: FindingService,
    private readonly analysis: BehaviorAnalysisService,
    private readonly reviews: ReviewService
  ) {}

  async resolve(findingId: string, request: ResolveFindingRequest = {}): Promise<ResolutionAttempt> {
    const finding = await this.findings.get(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);
    if (finding.status !== "open") throw new Error(`Finding in status '${finding.status}' cannot be resolved`);
    const originalRun = await this.store.getRun(finding.runId);
    if (!originalRun?.workspacePath) throw new Error("The builder workspace is unavailable for resolution");
    const intent = originalRun.intentId
      ? await this.store.getIntent(originalRun.intentId)
      : await this.store.getIntentForRun(originalRun.id);
    if (!intent) throw new Error("The original run has no attached intent");

    const resolverAgentId = request.resolverAgentId ?? "agentguard-deterministic-resolver";
    const attempt: ResolutionAttempt = {
      id: createId("resolution"),
      findingId,
      taskId: finding.taskId,
      originalRunId: finding.runId,
      resolverAgentId,
      status: "pending",
      filesChanged: [],
      createdAt: new Date().toISOString()
    };
    await this.store.createResolution(attempt);
    await this.findings.transition(findingId, "resolving");
    void this.execute(attempt, finding, originalRun.workspacePath, intent.id, request);
    return attempt;
  }

  async waitForResolution(id: string, timeoutMs = 30 * 60 * 1000): Promise<ResolutionAttempt> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const attempt = await this.store.getResolution(id);
      if (!attempt) throw new Error(`Resolution not found: ${id}`);
      if (["resolved", "failed"].includes(attempt.status)) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for resolution ${id}`);
  }

  private async execute(
    attempt: ResolutionAttempt,
    finding: Finding,
    sourceWorkspace: string,
    intentId: string,
    request: ResolveFindingRequest
  ): Promise<void> {
    try {
      const originalRun = await this.store.getRun(finding.runId);
      if (!originalRun) throw new Error("Original run disappeared during resolution");
      const permissions = (await this.store.getPermissions(originalRun.id)) ?? {};
      const command = request.command ?? (request.agent ? undefined : defaultResolutionCommand(finding, request));
      const runRequest: CreateRunRequest = {
        taskId: finding.taskId,
        agentId: attempt.resolverAgentId,
        repo: { path: sourceWorkspace },
        command,
        agent: request.agent,
        permissions,
        expectedFiles: originalRun.expectedFiles,
        timeoutMs: originalRun.timeoutMs,
        cleanupWorkspace: false,
        runtime: {
          provider: originalRun.runtimeProvider,
          baseVm: originalRun.runtimeBaseVm,
          image: originalRun.runtimeImage
        },
        intentId,
        purpose: "resolver",
        parentRunId: originalRun.id
      };
      const resolutionRun = await this.runtime.createRun(runRequest);
      await this.store.updateResolution(attempt.id, { status: "running", resolutionRunId: resolutionRun.id });
      const completed = await this.runtime.waitForTerminal(resolutionRun.id, originalRun.timeoutMs + 30_000);
      const runEvents = await this.store.getEvents(completed.id);
      const processExitEvents = runEvents.filter((event) => event.category === "process" && event.action === "exit");
      await this.store.updateResolution(attempt.id, {
        status: "re_reviewing",
        filesChanged: completed.gitSummary?.files ?? [],
        resultingDiff: completed.gitSummary?.diff,
        testResult: {
          passed: completed.status === "completed" && completed.exitCode === 0,
          exitCode: completed.exitCode,
          eventIds: processExitEvents.map((event) => event.id)
        }
      });
      await this.findings.transition(finding.id, "re_reviewing");

      await this.analysis.analyzeRun(completed.id);
      const review = await this.reviews.create(completed.id);
      const resolutionFindings = await this.findings.list({ runId: completed.id, status: "open" });
      const stillPresent = targetedConditionPresent(finding, completed.gitSummary?.files ?? [], resolutionFindings);
      const passed = completed.status === "completed" && completed.exitCode === 0 && review.status !== "failed" && !stillPresent;

      if (passed) {
        await this.findings.transition(finding.id, "resolved");
        await this.resolveRelatedFindings(finding, completed.id, completed.gitSummary?.files ?? []);
        await this.store.updateResolution(attempt.id, {
          status: "resolved",
          reviewId: review.id,
          reReviewResult: { passed: true, summary: review.summary ?? "Resolution verified." },
          completedAt: new Date().toISOString()
        });
      } else {
        await this.findings.transition(finding.id, "open");
        await this.store.updateResolution(attempt.id, {
          status: "failed",
          reviewId: review.id,
          reReviewResult: { passed: false, summary: review.summary ?? "Resolution did not pass re-review." },
          failureReason: stillPresent ? "The original finding condition remains present" : "Resolver run or re-review failed",
          completedAt: new Date().toISOString()
        });
      }

      await this.events.emitEvent({
        runId: completed.id,
        taskId: completed.taskId,
        agentId: completed.agentId,
        category: "runtime",
        action: passed ? "resolution_verified" : "resolution_failed",
        severity: passed ? "info" : "medium",
        correlationId: attempt.id,
        metadata: { resolutionId: attempt.id, findingId: finding.id, reviewId: review.id }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.findings.get(finding.id);
      if (current?.status === "resolving" || current?.status === "re_reviewing") {
        await this.findings.transition(finding.id, "open").catch(() => undefined);
      }
      await this.store.updateResolution(attempt.id, {
        status: "failed",
        failureReason: message,
        completedAt: new Date().toISOString()
      });
    }
  }

  private async resolveRelatedFindings(original: Finding, resolutionRunId: string, finalFiles: string[]): Promise<void> {
    const resource = original.file ?? original.evidence?.observedResource;
    if (!resource) return;
    const normalized = resource.replace(/^\/workspace\//, "").replace(/\/$/, "");
    if (finalFiles.some((file) => file.replace(/\/$/, "") === normalized)) return;
    const related = (await this.store.listFindings()).filter((candidate) => {
      const candidateResource = candidate.file ?? candidate.evidence?.observedResource;
      return (
        candidate.id !== original.id &&
        candidate.status === "open" &&
        [original.runId, resolutionRunId].includes(candidate.runId) &&
        candidateResource?.replace(/^\/workspace\//, "").replace(/\/$/, "") === normalized &&
        ["spec_drift", "sensitive_change", "permission"].includes(candidate.type)
      );
    });
    for (const candidate of related) {
      await this.findings.transition(candidate.id, "resolving");
      await this.findings.transition(candidate.id, "re_reviewing");
      await this.findings.transition(candidate.id, "resolved");
    }
  }
}

function defaultResolutionCommand(finding: Finding, request: ResolveFindingRequest): string[] {
  if ((request.strategy ?? "revert_file") !== "revert_file") throw new Error("Unsupported resolution strategy");
  const file = safeRelativePath(finding.file ?? finding.evidence?.observedResource);
  if (!file) throw new Error("revert_file resolution requires a file-backed finding");
  const testLabel = request.testCommand?.length ? request.testCommand.join(" ") : "npm test";
  const test = request.testCommand?.length ? shellJoin(request.testCommand) : 'if [ -f package.json ]; then npm test; fi';
  const callEvent = shellQuote(
    `AGENTGUARD_EVENT ${JSON.stringify({ category: "agent", action: "tool_call", resource: "shell", metadata: { command: testLabel } })}`
  );
  const script = [
    'target="$1"',
    'if git cat-file -e "HEAD:$target" >/dev/null 2>&1; then git checkout HEAD -- "$target"; else rm -rf -- "$target"; fi',
    `printf '%s\\n' ${callEvent}`,
    test,
    'status=$?',
    `printf 'AGENTGUARD_EVENT {"category":"agent","action":"tool_result","resource":"shell","metadata":{"command":${JSON.stringify(testLabel)},"exitCode":%s}}\\n' "$status"`,
    'exit "$status"'
  ].join("; ");
  return ["bash", "-lc", script, "agentguard-resolver", file];
}

function safeRelativePath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^\/workspace\//, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe resolution path: ${value}`);
  }
  return normalized;
}

function shellJoin(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function equivalentCondition(original: Finding, candidate: Finding): boolean {
  const originalResource = original.file ?? original.evidence?.observedResource;
  const candidateResource = candidate.file ?? candidate.evidence?.observedResource;
  return original.type === candidate.type && originalResource === candidateResource && candidate.severity !== "info";
}

function targetedConditionPresent(original: Finding, finalFiles: string[], candidates: Finding[]): boolean {
  const resource = original.file ?? original.evidence?.observedResource;
  if (resource && ["spec_drift", "sensitive_change", "permission", "code_quality"].includes(original.type)) {
    const normalized = resource.replace(/^\/workspace\//, "").replace(/\/$/, "");
    return finalFiles.some((file) => file.replace(/\/$/, "") === normalized);
  }
  return candidates.some((candidate) => equivalentCondition(original, candidate));
}
