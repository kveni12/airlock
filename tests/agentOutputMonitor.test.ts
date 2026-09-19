import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { AgentOutputMonitor } from "../src/telemetry/agentOutputMonitor.js";
import type { AgentKind, RunRecord } from "../src/types.js";

describe("AgentOutputMonitor", () => {
  it("normalizes the agent protocol, owns run identity, and redacts output", async () => {
    const harness = await createHarness("custom");
    harness.events.registerSecrets(harness.run.id, { API_TOKEN: "do-not-store" });

    harness.monitor.observe({
      stream: "stdout",
      line: 'AGENTGUARD_EVENT {"runId":"spoofed","category":"agent","action":"tool_call","resource":"shell","metadata":{"command":"API_TOKEN=do-not-store npm test"}}'
    });
    await harness.monitor.flush();

    const [event] = await harness.events.getEvents(harness.run.id);
    expect(event.runId).toBe(harness.run.id);
    expect(event.category).toBe("agent");
    expect(event.action).toBe("tool_call");
    expect(event.metadata?.reportedByAgent).toBe(true);
    expect(JSON.stringify(event)).not.toContain("do-not-store");
    await harness.cleanup();
  });

  it("normalizes Codex command and MCP records", async () => {
    const harness = await createHarness("codex");
    harness.monitor.observe({
      stream: "stdout",
      line: '{"type":"item.started","item":{"type":"command_execution","command":"npm test","status":"in_progress"}}'
    });
    harness.monitor.observe({
      stream: "stdout",
      line: '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"github","tool":"create_issue","status":"completed","result":"ok"}}'
    });
    await harness.monitor.flush();

    const events = await harness.events.getEvents(harness.run.id);
    expect(events.map((event) => `${event.category}.${event.action}`)).toEqual([
      "process.command_start",
      "mcp.tool_result"
    ]);
    expect(events[1].resource).toBe("github/create_issue");
    await harness.cleanup();
  });

  it("extracts Claude tool calls and preserves unstructured stderr", async () => {
    const harness = await createHarness("claude_code");
    harness.monitor.observe({
      stream: "stdout",
      line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Running tests"},{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"npm test"}}]}}'
    });
    harness.monitor.observe({ stream: "stderr", line: "warning from agent" });
    await harness.monitor.flush();

    const events = await harness.events.getEvents(harness.run.id);
    expect(events.map((event) => `${event.category}.${event.action}`)).toEqual([
      "agent.message",
      "agent.tool_call",
      "process.output"
    ]);
    expect(events[2].metadata).toMatchObject({ stream: "stderr", text: "warning from agent" });
    await harness.cleanup();
  });

  it("reports malformed explicit telemetry instead of silently dropping it", async () => {
    const harness = await createHarness("custom");
    harness.monitor.observe({ stream: "stdout", line: "AGENTGUARD_EVENT not-json" });
    await harness.monitor.flush();

    const [event] = await harness.events.getEvents(harness.run.id);
    expect(`${event.category}.${event.action}`).toBe("runtime.telemetry_degraded");
    expect(event.metadata?.subsystem).toBe("agent_output");
    await harness.cleanup();
  });
});

async function createHarness(kind: AgentKind) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-output-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  const events = new EventCollector(store, new PolicyEngine(async () => undefined));
  const run: RunRecord = {
    id: `run_${kind}`,
    taskId: "task_output",
    agentId: "agent_output",
    agent: { kind, command: ["agent"] },
    runtimeProvider: "lima",
    status: "running",
    createdAt: new Date().toISOString(),
    repoPath: directory,
    command: ["agent"],
    environmentKeys: [],
    timeoutMs: 10_000,
    expectedFiles: [],
    cleanupWorkspace: true
  };
  return {
    run,
    events,
    monitor: new AgentOutputMonitor(run, events),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
