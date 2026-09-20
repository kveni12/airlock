import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { FindingService } from "../src/findings/findingService.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentIntent, RunRecord } from "../src/types.js";

describe("FindingService", () => {
  it("creates, filters, transitions, dismisses, and retains evidence", async () => {
    const harness = await createHarness();
    const finding = await harness.findings.create({
      taskId: "task_1",
      runId: "run_1",
      source: "intent_comparison",
      type: "spec_drift",
      severity: "high",
      title: "Unexpected file",
      description: "infra/prod.tf was unexpected",
      file: "infra/prod.tf",
      evidence: { eventIds: ["evt_1"], observedResource: "infra/prod.tf" }
    });

    expect(await harness.findings.list({ status: "open", severity: "high", runId: "run_1" })).toHaveLength(1);
    expect((await harness.findings.get(finding.id))?.evidence?.eventIds).toEqual(["evt_1"]);
    expect((await harness.findings.transition(finding.id, "resolving")).status).toBe("resolving");
    expect((await harness.findings.transition(finding.id, "re_reviewing")).status).toBe("re_reviewing");
    expect((await harness.findings.transition(finding.id, "open")).status).toBe("open");
    const dismissed = await harness.findings.dismiss(finding.id, { reason: "Expected", actor: "human" });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissal?.reason).toBe("Expected");
    await harness.cleanup();
  });

  it("converts policy violations into unified findings with source references", async () => {
    const harness = await createHarness();
    await harness.events.emitEvent({
      runId: "run_policy",
      taskId: "task_policy",
      agentId: "agent_policy",
      category: "policy",
      action: "violation",
      resource: "infra/prod.tf",
      severity: "high",
      metadata: { rule: "unexpected_file_change", message: "Unexpected", sourceEventId: "evt_source" }
    });
    await harness.findings.flush();

    const [finding] = await harness.findings.list({ source: "policy" });
    expect(finding.type).toBe("spec_drift");
    expect(finding.evidence?.eventIds).toEqual(expect.arrayContaining(["evt_source"]));
    await harness.cleanup();
  });

  it("classifies findings, links them to the run's request and intent, and dedupes by affected resource", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: "run_trace",
      taskId: "task_trace",
      agentId: "builder",
      runtimeProvider: "process",
      status: "completed",
      createdAt: now,
      repoPath: "/tmp/repo",
      command: ["builder"],
      environmentKeys: [],
      timeoutMs: 1000,
      expectedFiles: [],
      cleanupWorkspace: false,
      intentId: "intent_trace",
      requestId: "req_trace"
    };
    await harness.store.createRun(run, {});
    const intent: AgentIntent = {
      id: "intent_trace",
      taskId: run.taskId,
      runId: run.id,
      requestId: "req_trace",
      goal: "Fix auth",
      summary: "Fix auth",
      plannedChanges: [],
      plannedActions: [],
      interpretation: "",
      expectedCommands: [],
      expectedTools: [],
      assumptions: [],
      expectedFiles: ["src/auth/**"],
      expectedDependencies: [],
      expectedNetwork: [],
      expectedMcpServers: [],
      expectedSecrets: [],
      constraints: [],
      createdBy: { agentId: "builder", agentType: "custom" },
      createdAt: now
    };
    await harness.store.createIntent(intent);

    await harness.events.emitEvent({
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      category: "policy",
      action: "violation",
      resource: "/workspace/infra/prod.tf",
      severity: "high",
      metadata: { rule: "permission_scope", message: "Outside granted scope" }
    });
    await harness.findings.flush();
    const [violation] = await harness.findings.list({ source: "policy" });
    expect(violation.classification).toBe("permission_violation");
    expect(violation.evidence?.requestId).toBe("req_trace");
    expect(violation.evidence?.intentId).toBe("intent_trace");

    const drift = await harness.findings.create({
      taskId: run.taskId,
      runId: run.id,
      source: "intent_comparison",
      type: "spec_drift",
      severity: "medium",
      title: "File changed outside declared intent",
      description: "infra/prod.tf",
      file: "infra/prod.tf"
    });
    expect(drift.classification).toBe("plan_drift");
    expect(drift.evidence?.intentId).toBe("intent_trace");
    const again = await harness.findings.create({
      taskId: run.taskId,
      runId: run.id,
      source: "intent_comparison",
      type: "spec_drift",
      severity: "medium",
      title: "File changed outside declared intent",
      description: "infra/prod.tf again",
      file: "infra/prod.tf",
      evidence: { observedResource: "infra/prod.tf" }
    });
    expect(again.id).toBe(drift.id);

    expect(await harness.findings.list({ runId: run.id, classification: "plan_drift" })).toHaveLength(1);
    expect(await harness.findings.list({ runId: run.id })).toHaveLength(2);
    await harness.cleanup();
  });
});

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-findings-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const findings = new FindingService(store, events);
  return { store, events, findings, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
