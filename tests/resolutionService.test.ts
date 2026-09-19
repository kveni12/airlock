import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BehaviorAnalysisService } from "../src/analysis/behaviorAnalyzer.js";
import { EventCollector } from "../src/events/eventCollector.js";
import { FindingService } from "../src/findings/findingService.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { ResolutionService } from "../src/resolution/resolutionService.js";
import { ReviewService } from "../src/review/reviewService.js";
import type { RuntimeManager } from "../src/runtime/runtimeManager.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentIntent, CreateRunRequest, RunRecord } from "../src/types.js";

describe("ResolutionService", () => {
  it("moves open through resolving and re-reviewing to resolved after verification", async () => {
    const harness = await createHarness(false);
    const attempt = await harness.resolutions.resolve(harness.findingId, { command: ["true"] });
    const completed = await harness.resolutions.waitForResolution(attempt.id, 5000);
    expect(completed.status).toBe("resolved");
    expect(completed.testResult?.passed).toBe(true);
    expect(completed.reviewId).toBeTruthy();
    expect((await harness.findings.get(harness.findingId))?.status).toBe("resolved");
    expect((await harness.findings.get(harness.relatedFindingId))?.status).toBe("resolved");
    await harness.cleanup();
  });

  it("keeps the original finding open when the condition remains", async () => {
    const harness = await createHarness(true);
    const attempt = await harness.resolutions.resolve(harness.findingId, { command: ["true"] });
    const completed = await harness.resolutions.waitForResolution(attempt.id, 5000);
    expect(completed.status).toBe("failed");
    expect(completed.failureReason).toContain("remains present");
    expect((await harness.findings.get(harness.findingId))?.status).toBe("open");
    await harness.cleanup();
  });
});

async function createHarness(keepUnexpectedFile: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-resolution-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  const originalRun: RunRecord = {
    id: "run_original",
    taskId: "task_resolution",
    agentId: "builder",
    runtimeProvider: "lima",
    runtimeBaseVm: "agentguard-base",
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    repoPath: directory,
    workspacePath: directory,
    command: ["builder"],
    environmentKeys: [],
    timeoutMs: 1000,
    expectedFiles: ["src/auth/**"],
    cleanupWorkspace: false,
    intentId: "intent_resolution",
    gitSummary: {
      filesChanged: 2,
      insertions: 2,
      deletions: 0,
      files: ["src/auth/oauth.ts", "infra/prod.tf"],
      commits: [],
      dependencyChanges: []
    }
  };
  const intent: AgentIntent = {
    id: "intent_resolution",
    taskId: originalRun.taskId,
    runId: originalRun.id,
    goal: "Add OAuth",
    summary: "Add OAuth",
    plannedChanges: ["Add OAuth"],
    plannedActions: ["Add OAuth"],
    interpretation: "",
    expectedCommands: [],
    expectedTools: [],
    assumptions: [],
    expectedFiles: ["src/auth/**"],
    expectedDependencies: [],
    expectedNetwork: [],
    expectedMcpServers: [],
    expectedSecrets: [],
    constraints: ["Do not modify infrastructure"],
    createdBy: { agentId: "builder", agentType: "custom" },
    createdAt: new Date().toISOString()
  };
  await store.createRun(originalRun, {});
  await store.createIntent(intent);
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const findings = new FindingService(store, events);
  const finding = await findings.create({
    taskId: originalRun.taskId,
    runId: originalRun.id,
    source: "intent_comparison",
    type: "spec_drift",
    severity: "high",
    title: "File changed outside declared intent",
    description: "infra/prod.tf was unexpected",
    file: "infra/prod.tf",
    evidence: { eventIds: ["evt_infra"], observedResource: "infra/prod.tf" }
  });
  const relatedFinding = await findings.create({
    taskId: originalRun.taskId,
    runId: originalRun.id,
    source: "policy",
    type: "sensitive_change",
    severity: "high",
    title: "Sensitive file modification",
    description: "infra/prod.tf was sensitive",
    file: "infra/prod.tf",
    evidence: { eventIds: ["evt_policy"], observedResource: "infra/prod.tf" }
  });
  const analysis = new BehaviorAnalysisService(store, findings);
  const reviews = new ReviewService(store, events, findings, analysis);
  const fakeRuntime = new FakeRuntime(store, keepUnexpectedFile) as unknown as RuntimeManager;
  const resolutions = new ResolutionService(store, events, fakeRuntime, findings, analysis, reviews);
  return {
    store,
    findings,
    resolutions,
    findingId: finding.id,
    relatedFindingId: relatedFinding.id,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

class FakeRuntime {
  constructor(
    private readonly store: JsonStore,
    private readonly keepUnexpectedFile: boolean
  ) {}

  async createRun(request: CreateRunRequest): Promise<RunRecord> {
    const files = this.keepUnexpectedFile ? ["src/auth/oauth.ts", "infra/prod.tf"] : ["src/auth/oauth.ts"];
    const run: RunRecord = {
      id: "run_resolution",
      taskId: request.taskId,
      agentId: request.agentId,
      runtimeProvider: "lima",
      status: "completed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      repoPath: request.repo.path,
      workspacePath: request.repo.path,
      command: request.command ?? ["resolver"],
      environmentKeys: [],
      timeoutMs: request.timeoutMs ?? 1000,
      expectedFiles: request.expectedFiles ?? [],
      cleanupWorkspace: false,
      intentId: request.intentId,
      purpose: "resolver",
      parentRunId: request.parentRunId,
      gitSummary: {
        filesChanged: files.length,
        insertions: files.length,
        deletions: 0,
        files,
        commits: [],
        dependencyChanges: []
      }
    };
    await this.store.createRun(run, request.permissions ?? {});
    for (const file of files) {
      await this.store.addEvent({
        id: `evt_${file}`,
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        timestamp: new Date().toISOString(),
        category: "git",
        action: "file_changed",
        resource: file
      });
    }
    await this.store.addEvent({
      id: "evt_process_exit",
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      timestamp: new Date().toISOString(),
      category: "process",
      action: "exit",
      resource: "resolver",
      metadata: { exitCode: 0 }
    });
    return run;
  }

  async waitForTerminal(runId: string): Promise<RunRecord> {
    return (await this.store.getRun(runId)) as RunRecord;
  }
}
