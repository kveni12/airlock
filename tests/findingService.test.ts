import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { FindingService } from "../src/findings/findingService.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { JsonStore } from "../src/store/jsonStore.js";

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
});

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-findings-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const findings = new FindingService(store, events);
  return { store, events, findings, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
