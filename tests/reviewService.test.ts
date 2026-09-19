import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BehaviorAnalysisService } from "../src/analysis/behaviorAnalyzer.js";
import { EventCollector } from "../src/events/eventCollector.js";
import { FindingService } from "../src/findings/findingService.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { ReviewService } from "../src/review/reviewService.js";
import { parseReviewerOutput } from "../src/review/reviewer.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentIntent, RunRecord } from "../src/types.js";

describe("reviewer output", () => {
  it("rejects malformed output and unchanged-file coverage", () => {
    expect(() => parseReviewerOutput("not-json", ["src/a.ts"])).toThrow("not valid JSON");
    expect(() =>
      parseReviewerOutput(
        { summary: "ok", verdict: "approve", reviewedFiles: ["src/not-changed.ts"], findings: [] },
        ["src/a.ts"]
      )
    ).toThrow("unchanged file");
  });
});

describe("ReviewService", () => {
  it("tracks exact file coverage and reviewer findings", async () => {
    const harness = await createHarness();
    const review = await harness.reviews.create("run_review", {
      reviewerAgentId: "reviewer_1",
      structuredOutput: {
        summary: "One file has a defect.",
        verdict: "needs_human",
        reviewedFiles: ["src/a.ts"],
        findings: [
          {
            type: "code_quality",
            severity: "medium",
            title: "Missing guard",
            description: "Input is not checked.",
            file: "src/a.ts",
            line: 4,
            evidenceEventIds: ["evt_file_a"]
          }
        ]
      }
    });

    expect(review.status).toBe("needs_human");
    expect(review.filesReviewed).toBe(1);
    expect(review.filesWithFindings).toBe(1);
    expect(review.fileReviews).toEqual([
      expect.objectContaining({ path: "src/a.ts", status: "finding" }),
      expect.objectContaining({ path: "src/b.ts", status: "pending" })
    ]);
    expect(await harness.findings.list({ source: "reviewer" })).toHaveLength(1);
    await harness.cleanup();
  });

  it("persists reviewer failure without crashing the builder run", async () => {
    const harness = await createHarness();
    const review = await harness.reviews.create("run_review", { structuredOutput: "bad-json" });
    expect(review.status).toBe("failed");
    expect(review.failureReason).toContain("not valid JSON");
    expect((await harness.store.getRun("run_review"))?.status).toBe("completed");
    expect((await harness.events.getEvents("run_review")).some((event) => event.action === "review_reviewer_failed")).toBe(true);
    await harness.cleanup();
  });

  it("persists human approval and emits an approval event", async () => {
    const harness = await createHarness();
    const review = await harness.reviews.create("run_review");
    const approved = await harness.reviews.approve(review.id, { actor: "alice", reason: "Reviewed" });
    expect(approved.status).toBe("approved");
    expect(approved.approval).toEqual({ actor: "alice", reason: "Reviewed" });
    expect((await harness.events.getEvents("run_review")).some((event) => event.action === "review_approved")).toBe(true);
    expect(approved.summary).toMatch(/^Approved by alice/);
    await harness.cleanup();
  });

  it("persists human rejection, rewrites the summary and blocks later approval", async () => {
    const harness = await createHarness();
    const review = await harness.reviews.create("run_review");
    const rejected = await harness.reviews.reject(review.id, { actor: "alice", reason: "Touches infra" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedAt).toBeDefined();
    expect(rejected.rejection).toEqual({ actor: "alice", reason: "Touches infra" });
    expect(rejected.summary).toContain("Rejected by alice");
    expect(rejected.summary).toContain("Touches infra");
    expect((await harness.events.getEvents("run_review")).some((event) => event.action === "review_rejected")).toBe(true);
    await expect(harness.reviews.approve(review.id, { actor: "bob" })).rejects.toThrow("cannot be approved");
    await expect(harness.reviews.reject(review.id, { actor: "bob" })).rejects.toThrow("cannot be rejected");
    await harness.cleanup();
  });
});

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-review-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  await store.createRun(run, {});
  await store.createIntent(intent);
  await store.addEvent({
    id: "evt_file_a",
    runId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    timestamp: new Date().toISOString(),
    category: "git",
    action: "file_changed",
    resource: "src/a.ts"
  });
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const findings = new FindingService(store, events);
  const analysis = new BehaviorAnalysisService(store, findings);
  const reviews = new ReviewService(store, events, findings, analysis);
  return { store, events, findings, reviews, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const run: RunRecord = {
  id: "run_review",
  taskId: "task_review",
  agentId: "builder_review",
  runtimeProvider: "lima",
  status: "completed",
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  repoPath: "/tmp/repo",
  workspacePath: "/tmp/workspace",
  command: ["agent"],
  environmentKeys: [],
  timeoutMs: 1000,
  expectedFiles: ["src/a.ts", "src/b.ts"],
  cleanupWorkspace: false,
  intentId: "intent_review",
  gitSummary: {
    filesChanged: 2,
    insertions: 2,
    deletions: 0,
    files: ["src/a.ts", "src/b.ts"],
    commits: [],
    dependencyChanges: [],
    diff: "diff"
  }
};

const intent: AgentIntent = {
  id: "intent_review",
  taskId: "task_review",
  runId: "run_review",
  goal: "Change two files",
  summary: "Change two files",
  plannedChanges: ["Change a", "Change b"],
  plannedActions: ["Change a", "Change b"],
  interpretation: "",
  expectedCommands: [],
  expectedTools: [],
  assumptions: [],
  expectedFiles: ["src/a.ts", "src/b.ts"],
  expectedDependencies: [],
  expectedNetwork: [],
  expectedMcpServers: [],
  expectedSecrets: [],
  constraints: [],
  createdBy: { agentId: "builder_review", agentType: "custom" },
  createdAt: new Date().toISOString()
};
