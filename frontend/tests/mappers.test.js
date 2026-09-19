import test from "node:test";
import assert from "node:assert/strict";
import { isRunActive, permissionCount, statusLabel, summarizeSnapshot } from "../lib/mappers.js";

test("isRunActive recognizes every in-flight run status", () => {
  for (const status of ["pending", "starting", "running", "stopping"]) assert.equal(isRunActive(status), true);
  for (const status of ["completed", "failed", "stopped"]) assert.equal(isRunActive(status), false);
});

test("summarizeSnapshot counts unique active agents and recorded evidence", () => {
  const snapshot = {
    runs: [
      { id: "run-1", agentId: "agent-a", status: "running", gitSummary: { filesChanged: 3 } },
      { id: "run-2", agentId: "agent-a", status: "starting", gitSummary: { filesChanged: 2 } },
      { id: "run-3", agentId: "agent-b", status: "completed" }
    ],
    eventsByRun: {
      "run-1": [{ id: "event-1", category: "policy" }, { id: "event-2", category: "filesystem" }],
      "run-2": [{ id: "event-3", category: "policy" }]
    }
  };

  assert.deepEqual(summarizeSnapshot(snapshot), {
    activeAgents: 1,
    policyAlerts: 2,
    filesChanged: 5,
    recordedEvents: 3
  });
});

test("permissionCount totals all permission surfaces and handles missing fields", () => {
  assert.equal(permissionCount({ filesystem: [{ path: "/src" }], network: ["api.example.com"], secrets: ["TOKEN"], mcpServers: ["github"], tools: ["shell", "git"] }), 6);
  assert.equal(permissionCount({}), 0);
  assert.equal(statusLabel("telemetry_degraded"), "Telemetry degraded");
});
