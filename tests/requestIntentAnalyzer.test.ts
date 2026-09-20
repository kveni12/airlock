import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RequestIntentAnalyzer } from "../src/analysis/requestIntentAnalyzer.js";
import { FindingService } from "../src/findings/findingService.js";
import { IntentAlignmentService } from "../src/intent/intentAlignmentService.js";
import { IntentService } from "../src/intent/intentService.js";
import { RequestAnalyzer } from "../src/request/requestAnalyzer.js";
import { RequestService } from "../src/request/requestService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentIntent, AgentIntentDraft, HumanRequest } from "../src/types.js";

const analyzer = new RequestIntentAnalyzer();

function request(rawPrompt: string): HumanRequest {
  return { id: "req_1", taskId: "task_1", rawPrompt, createdAt: new Date().toISOString() };
}

function intent(overrides: Partial<AgentIntentDraft>): AgentIntent {
  const plannedChanges = overrides.plannedChanges ?? overrides.plannedActions ?? [];
  return {
    id: "intent_1",
    taskId: "task_1",
    requestId: "req_1",
    goal: overrides.goal ?? "Fix login failures caused by expired sessions",
    summary: overrides.summary ?? "",
    interpretation: overrides.interpretation ?? "Correct the session validation bug without touching persistence.",
    plannedChanges,
    plannedActions: plannedChanges,
    expectedFiles: overrides.expectedFiles ?? ["src/auth/session.ts", "tests/auth/session.test.ts"],
    expectedDependencies: overrides.expectedDependencies ?? [],
    expectedCommands: overrides.expectedCommands ?? ["npm test"],
    expectedNetwork: overrides.expectedNetwork ?? [],
    expectedMcpServers: overrides.expectedMcpServers ?? [],
    expectedTools: overrides.expectedTools ?? ["filesystem", "shell"],
    expectedSecrets: overrides.expectedSecrets ?? [],
    constraints: overrides.constraints ?? ["Do not modify the database"],
    assumptions: overrides.assumptions ?? [],
    createdBy: { agentId: "planner", agentType: "codex" },
    createdAt: new Date().toISOString()
  };
}

function analyze(prompt: string, draft: Partial<AgentIntentDraft>) {
  const humanRequest = request(prompt);
  const analysis = new RequestAnalyzer().analyze(humanRequest);
  return analyzer.analyze(humanRequest, analysis, intent(draft));
}

describe("RequestIntentAnalyzer", () => {
  it("reports an aligned intent with no findings", () => {
    const result = analyze("Fix the login bug. Do not modify the database.", {
      plannedChanges: ["Inspect authentication middleware", "Modify session validation", "Add regression test for login", "Run authentication tests"]
    });
    expect(result.status).toBe("aligned");
    expect(result.findings).toEqual([]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("flags an explicit constraint violation as a high-severity conflict with both excerpts", () => {
    const result = analyze("Fix the login bug. Do not modify the database.", {
      plannedChanges: ["Inspect auth middleware", "Modify session handling", "Modify users table"]
    });
    expect(result.status).toBe("conflict");
    const violation = result.findings.find((finding) => finding.title === "Intent violates explicit user constraint");
    expect(violation).toBeDefined();
    expect(violation?.severity).toBe("high");
    expect(violation?.source).toBe("request_intent_comparison");
    expect(violation?.evidence?.humanRequestExcerpt).toBe("Do not modify the database.");
    expect(violation?.evidence?.agentIntentExcerpt).toBe("Modify users table");
    expect(violation?.evidence?.verification).toBe("independent");
  });

  it("treats forbidden resources found in expected files as a violation", () => {
    const result = analyze("Fix the login bug. Do not modify infrastructure configuration.", {
      plannedChanges: ["Fix login bug"],
      expectedFiles: ["src/auth/session.ts", "infra/prod.tf"]
    });
    expect(result.status).toBe("conflict");
    expect(result.findings[0]?.evidence?.agentIntentExcerpt).toBe("infra/prod.tf");
  });

  it("does not report a violation for resources the human never mentioned", () => {
    const result = analyze("Fix the login bug.", {
      plannedChanges: ["Fix login bug", "Add a database migration for sessions"],
      constraints: []
    });
    expect(result.findings.filter((finding) => finding.severity === "high")).toEqual([]);
  });

  it("surfaces a missing requested objective as an inferred warning", () => {
    const result = analyze("Fix the login bug and add a regression test.", {
      plannedChanges: ["Inspect login flow", "Modify session validation"],
      expectedFiles: ["src/auth/session.ts"],
      constraints: []
    });
    expect(result.status).toBe("warning");
    const missing = result.findings.find((finding) => finding.title === "Requested objective not addressed in intent");
    expect(missing?.severity).toBe("medium");
    expect(missing?.evidence?.humanRequestExcerpt).toContain("regression test");
    expect(missing?.evidence?.verification).toBe("inferred");
  });

  it("flags conservative scope expansion when broad-change verbs share no wording with the request", () => {
    const result = analyze("Fix button styling on the settings page.", {
      goal: "Fix button styling",
      interpretation: "Fix styling",
      plannedChanges: ["Fix button styling", "Refactor authentication system"],
      constraints: []
    });
    const expansion = result.findings.find((finding) => finding.title === "Intent may expand beyond the requested scope");
    expect(expansion?.evidence?.agentIntentExcerpt).toBe("Refactor authentication system");
    expect(expansion?.evidence?.verification).toBe("inferred");
    expect(result.status).toBe("warning");
  });

  it("notes an explicit constraint the intent does not restate at low severity", () => {
    const result = analyze("Fix the login bug. Do not add external dependencies.", {
      plannedChanges: ["Fix login bug"],
      constraints: []
    });
    expect(result.status).toBe("warning");
    expect(result.findings.map((finding) => finding.severity)).toEqual(["low"]);
  });
});

describe("IntentAlignmentService", () => {
  it("persists findings, records the decision on the intent, and gates execution", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentguard-align-"));
    const store = new JsonStore(path.join(dir, "store.json"));
    await store.init();
    const requests = new RequestService(store);
    const intents = new IntentService(store);
    const findings = new FindingService(store);
    const service = new IntentAlignmentService(store, intents, findings);

    const { request: humanRequest } = await requests.create({ taskId: "task_1", rawPrompt: "Fix the login bug. Do not modify the database." });
    const created = await intents.create(
      "task_1",
      { goal: "Fix login", plannedChanges: ["Fix login bug", "Modify users table"], expectedFiles: ["src/auth.ts"], constraints: [] },
      { agentId: "planner", agentType: "codex", requestId: humanRequest.id }
    );
    expect(intents.executionBlockReason(created)).toContain("no request alignment decision");

    const result = await service.analyze(created.id);
    expect(result.alignment.status).toBe("conflict");
    expect(result.findings.map((finding) => finding.severity)).toEqual(["high", "low"]);
    expect(result.findings[0]?.runId).toBeUndefined();
    expect(result.findings[0]?.evidence?.requestId).toBe(humanRequest.id);
    expect(result.findings[0]?.evidence?.intentId).toBe(created.id);
    expect((await store.getIntent(created.id))?.alignment?.findingIds).toEqual(result.findings.map((finding) => finding.id));
    expect(intents.executionBlockReason(result.intent)).toContain("requires human approval");

    const approved = await intents.approve(created.id, { actor: "kveni", reason: "Migration is required" });
    expect(intents.executionBlockReason(approved)).toBeUndefined();

    await service.attachFindingsToRun(created.id, "run_1");
    expect((await store.getFinding(result.findings[0]!.id))?.runId).toBe("run_1");

    const revised = await intents.create(
      "task_1",
      { goal: "Fix login", plannedChanges: ["Fix login bug"], expectedFiles: ["src/auth.ts"], constraints: ["Do not modify the database"] },
      { agentId: "planner", agentType: "codex", requestId: humanRequest.id, supersedes: created.id }
    );
    expect((await store.getIntent(created.id))?.supersededBy).toBe(revised.id);
    expect(intents.executionBlockReason((await store.getIntent(created.id))!)).toContain("superseded");
    const aligned = await service.analyze(revised.id);
    expect(aligned.alignment.status).toBe("aligned");
    expect(intents.executionBlockReason(aligned.intent)).toContain("requires human approval");

    const rejected = await intents.reject(revised.id, { actor: "kveni" });
    expect(intents.executionBlockReason(rejected)).toContain("rejected");
    await rm(dir, { recursive: true, force: true });
  });
});
