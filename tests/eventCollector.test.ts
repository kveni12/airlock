import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { JsonStore } from "../src/store/jsonStore.js";

describe("EventCollector", () => {
  it("normalizes, persists, and streams events for the correct run", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-events-"));
    const store = new JsonStore(path.join(directory, "store.json"));
    await store.init();
    const policy = new PolicyEngine(async () => ({ permissions: {}, expectedFiles: [] }));
    const collector = new EventCollector(store, policy);
    const streamed: string[] = [];

    const unsubscribe = collector.subscribe("run_1", (event) => streamed.push(event.id));
    const event = await collector.emitEvent({
      runId: "run_1",
      taskId: "task_1",
      agentId: "agent_1",
      category: "runtime",
      action: "started"
    });
    unsubscribe();

    const persisted = await collector.getEvents("run_1");
    expect(event.id).toMatch(/^evt_/);
    expect(event.timestamp).toBeTruthy();
    expect(persisted).toHaveLength(1);
    expect(streamed).toEqual([event.id]);
    expect(event.evidenceSource).toBe("runtime");
    expect(event.verification).toBe("independent");

    await rm(directory, { recursive: true, force: true });
  });

  it("marks agent semantic activity as agent-reported evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-event-provenance-"));
    const store = new JsonStore(path.join(directory, "store.json"));
    await store.init();
    const collector = new EventCollector(store, new PolicyEngine(async () => undefined));
    const event = await collector.emitEvent({
      runId: "run_reported",
      taskId: "task_reported",
      agentId: "agent_reported",
      category: "mcp",
      action: "tool_call",
      resource: "github/read_file"
    });
    expect(event.evidenceSource).toBe("agent_reported");
    expect(event.verification).toBe("agent_reported");
    await rm(directory, { recursive: true, force: true });
  });

  it("redacts registered run secret values before persistence and streaming", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-event-secrets-"));
    const store = new JsonStore(path.join(directory, "store.json"));
    await store.init();
    const collector = new EventCollector(store, new PolicyEngine(async () => undefined));
    const streamed: string[] = [];
    collector.registerSecrets("run_secret", { AGENT_TOKEN: "value-that-must-not-leak" });
    collector.subscribe("run_secret", (event) => streamed.push(JSON.stringify(event)));

    await collector.emitEvent({
      runId: "run_secret",
      taskId: "task_secret",
      agentId: "agent_secret",
      category: "process",
      action: "start",
      metadata: { args: ["--credential", "value-that-must-not-leak"] }
    });

    const persisted = JSON.stringify(await collector.getEvents("run_secret"));
    expect(persisted).not.toContain("value-that-must-not-leak");
    expect(streamed.join("")).not.toContain("value-that-must-not-leak");
    expect(persisted).toContain("[REDACTED]");

    await rm(directory, { recursive: true, force: true });
  });
});
