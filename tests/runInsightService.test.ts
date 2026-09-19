import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BehaviorAnalysisService } from "../src/analysis/behaviorAnalyzer.js";
import { RunInsightService } from "../src/dashboard/runInsightService.js";
import { EventCollector } from "../src/events/eventCollector.js";
import { FindingService } from "../src/findings/findingService.js";
import { IntentAlignmentService } from "../src/intent/intentAlignmentService.js";
import { IntentService } from "../src/intent/intentService.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { RequestService } from "../src/request/requestService.js";
import { ReviewService } from "../src/review/reviewService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentEvent, RunRecord } from "../src/types.js";

describe("RunInsightService", () => {
  it("composes alignment, counts, result, and run detail from canonical state", async () => {
    const h = await harness();
    const alignment = await h.insights.alignment(h.run.id);

    expect(alignment.requestToIntent.status).toBe("aligned");
    expect(alignment.requestToIntent.findingIds).toEqual([]);
    expect(alignment.intentToBehavior.status).toBe("warning");
    expect(alignment.counts).toEqual({
      undeclaredFiles: 0,
      undeclaredDependencies: 1,
      undeclaredNetworkDestinations: 1,
      undeclaredTools: 0,
      missingExpectedActions: 0
    });
    expect(alignment.behaviorToResult?.status).toBe("warning");
    expect(alignment.behaviorToResult?.detail).toContain("1/2 files reviewed");

    const detail = await h.insights.detail(h.run.id);
    expect(detail.request?.rawPrompt).toBe(PROMPT);
    expect(detail.requestAnalysis?.explicitlyForbiddenResources.map((r) => r.resource)).toEqual(["database"]);
    expect(detail.intent?.id).toBe(h.intentId);
    expect(detail.permissions?.network).toEqual([]);
    expect(detail.behaviorSummary?.dependenciesAdded.map((d) => d.name)).toEqual(["axios"]);
    expect(detail.behaviorSummary?.files.read).toMatchObject({ status: "unavailable" });
    expect(detail.behaviorSummary?.coverage.filesystemReads).toBe("unavailable");
    expect(detail.result.filesChanged).toEqual(["src/auth/session.ts", "tests/auth/session.test.ts"]);
    expect(detail.result.tests).toEqual([expect.objectContaining({ command: "npm test", verification: "independent" })]);
    expect(detail.result.approvalStatus).toBe("needs_human");
    expect(detail.result.findings).toMatchObject({ total: 3, open: 3 });
    expect(detail.findings.map((f) => f.source).sort()).toEqual(["intent_comparison", "intent_comparison", "reviewer"]);
    expect(detail.alignment).toEqual(alignment);
    await h.cleanup();
  });

  it("orders the timeline chronologically and preserves evidence references and provenance", async () => {
    const h = await harness();
    const timeline = await h.insights.timeline(h.run.id);
    const timestamps = timeline.map((entry) => entry.timestamp);
    expect([...timestamps].sort()).toEqual(timestamps);

    const kinds = timeline.map((entry) => entry.kind);
    expect(kinds.indexOf("human.request")).toBeLessThan(kinds.indexOf("agent.intent"));
    expect(kinds.indexOf("agent.intent")).toBeLessThan(kinds.indexOf("intent.analysis"));
    expect(kinds.indexOf("intent.analysis")).toBeLessThan(kinds.indexOf("runtime"));
    expect(kinds.indexOf("git")).toBeLessThan(kinds.indexOf("finding.created"));
    expect(kinds.indexOf("finding.created")).toBeLessThan(kinds.indexOf("review"));

    const request = timeline.find((entry) => entry.kind === "human.request");
    expect(request?.detail).toBe(PROMPT);
    expect(request?.refs.requestId).toBe(h.requestId);

    const network = timeline.find((entry) => entry.kind === "network");
    expect(network).toMatchObject({ evidenceSource: "proxy", verification: "independent", refs: { eventId: "evt_net" } });

    const tool = timeline.find((entry) => entry.kind === "agent");
    expect(tool).toMatchObject({ evidenceSource: "agent_reported", verification: "agent_reported", refs: { eventId: "evt_tool" } });

    const dependencyFinding = timeline.find((entry) => entry.kind === "finding.created" && entry.title === "Unexpected dependency added");
    expect(dependencyFinding).toMatchObject({ verification: "independent", refs: { intentId: h.intentId, requestId: h.requestId } });
    expect(dependencyFinding?.refs.findingId).toBeDefined();
    await h.cleanup();
  });

  it("does not claim request alignment when no request or analysis exists", async () => {
    const h = await harness({ withRequest: false });
    const alignment = await h.insights.alignment(h.run.id);
    expect(alignment.requestToIntent.status).toBe("warning");
    expect(alignment.requestToIntent.detail).toMatch(/not linked to a human request/);
    await h.cleanup();
  });
});

const PROMPT = "Fix the login bug and add a regression test. Do not modify the database.";

async function harness(options: { withRequest?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-insight-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const findings = new FindingService(store, events);
  const intents = new IntentService(store);
  const requests = new RequestService(store);
  const alignment = new IntentAlignmentService(store, intents, findings);
  const analysis = new BehaviorAnalysisService(store, findings);
  const reviews = new ReviewService(store, events, findings, analysis);
  const insights = new RunInsightService(store);

  let requestId: string | undefined;
  if (options.withRequest !== false) {
    requestId = (await requests.create({ taskId: "task_1", rawPrompt: PROMPT })).request.id;
    await tick();
  }
  const intent = await intents.create(
    "task_1",
    {
      goal: "Fix expired-session login failures",
      interpretation: "Fix the login bug in session handling and add a regression test without touching the database.",
      plannedActions: ["Modify session validation", "Add regression test", "Run authentication tests"],
      expectedFiles: ["src/auth/session.ts", "tests/auth/**"],
      expectedCommands: ["npm test"],
      constraints: ["Do not modify the database"]
    },
    { agentId: "planner", agentType: "codex", requestId }
  );
  await tick();
  if (requestId) await alignment.analyze(intent.id);
  await tick();

  const run: RunRecord = {
    id: "run_1",
    taskId: "task_1",
    agentId: "builder",
    runtimeProvider: "lima",
    status: "completed",
    createdAt: now(),
    startedAt: now(),
    repoPath: "/tmp/repo",
    command: ["agent"],
    environmentKeys: [],
    timeoutMs: 1000,
    expectedFiles: intent.expectedFiles,
    cleanupWorkspace: false,
    intentId: intent.id,
    requestId,
    gitSummary: {
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
      files: ["src/auth/session.ts", "tests/auth/session.test.ts"],
      commits: [],
      dependencyChanges: [{ name: "axios", type: "dependency_added" as const, manifest: "package.json" }]
    }
  };
  await store.createRun(run, { filesystem: [{ path: "src/**", access: "read_write" }], network: [], secrets: [], mcpServers: [] });
  if (requestId) await requests.attachToRun(requestId, run.id);
  await tick();

  const seq: Array<Partial<AgentEvent> & Pick<AgentEvent, "id" | "category" | "action">> = [
    { id: "evt_start", category: "runtime", action: "started", evidenceSource: "runtime", verification: "independent" },
    { id: "evt_fs", category: "filesystem", action: "write", resource: "/workspace/src/auth/session.ts", evidenceSource: "filesystem", verification: "independent" },
    { id: "evt_cmd", category: "process", action: "command_start", resource: "npm test", evidenceSource: "runtime", verification: "independent" },
    { id: "evt_test", category: "process", action: "test_result", resource: "npm test", metadata: { passed: true }, evidenceSource: "runtime", verification: "independent" },
    { id: "evt_tool", category: "agent", action: "tool_call", resource: "shell", evidenceSource: "agent_reported", verification: "agent_reported" },
    { id: "evt_net", category: "network", action: "request", resource: "api.foo.com", evidenceSource: "proxy", verification: "independent" },
    { id: "evt_git1", category: "git", action: "file_changed", resource: "src/auth/session.ts", evidenceSource: "git", verification: "independent" },
    { id: "evt_git2", category: "git", action: "file_changed", resource: "tests/auth/session.test.ts", evidenceSource: "git", verification: "independent" },
    { id: "evt_dep", category: "git", action: "dependency_added", resource: "axios", evidenceSource: "git", verification: "independent" },
    { id: "evt_done", category: "runtime", action: "completed", evidenceSource: "runtime", verification: "independent" }
  ];
  for (const event of seq) {
    await store.addEvent({ runId: run.id, taskId: run.taskId, agentId: run.agentId, allowed: true, timestamp: now(), ...event });
    await tick();
  }
  await store.updateRun(run.id, { completedAt: now() });
  await analysis.analyzeRun(run.id);
  await tick();
  await reviews.create(run.id, {
    reviewerAgentId: "reviewer",
    structuredOutput: {
      summary: "Session fix looks right; test file needs assertion.",
      verdict: "needs_human",
      reviewedFiles: ["src/auth/session.ts"],
      findings: [
        {
          type: "code_quality",
          severity: "low",
          title: "Missing null check",
          description: "Session lookup may be undefined.",
          file: "src/auth/session.ts",
          evidenceEventIds: ["evt_git1"]
        }
      ]
    }
  });

  return { store, run, requestId, intentId: intent.id, insights, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function now(): string {
  return new Date().toISOString();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}
