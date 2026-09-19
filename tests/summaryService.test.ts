import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SummaryService } from "../src/dashboard/summaryService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { Finding, RunRecord } from "../src/types.js";

describe("SummaryService", () => {
  it("keeps configured and observed access distinct and derives transparent risk counts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-summary-"));
    const store = new JsonStore(path.join(directory, "store.json"));
    await store.init();
    await store.createRun(run, {
      filesystem: [{ path: "/workspace/src", access: "read_write" }],
      network: ["github.com", "unused.example"],
      secrets: ["GITHUB_TOKEN"],
      mcpServers: [
        { id: "github", name: "github", transport: "stdio", tools: ["read_file"], status: "available" }
      ]
    });
    await store.addEvent({
      id: "evt_network",
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      timestamp: new Date().toISOString(),
      category: "network",
      action: "request",
      resource: "github.com"
    });
    await store.addEvent({
      id: "evt_mcp",
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      timestamp: new Date().toISOString(),
      category: "mcp",
      action: "tool_call",
      resource: "github/read_file",
      verification: "agent_reported"
    });
    await store.createFinding(finding);

    const service = new SummaryService(store);
    const agent = await service.agent(run.agentId);
    expect(agent.permissions.network).toEqual([
      expect.objectContaining({ host: "github.com", contacted: true }),
      expect.objectContaining({ host: "unused.example", contacted: false })
    ]);
    expect(agent.permissions.secrets[0]).toEqual(expect.objectContaining({ configured: true, observed: false }));
    expect(agent.permissions.mcpServers[0]).toEqual(expect.objectContaining({ configured: true, used: true }));
    const dashboard = await service.dashboard();
    expect(dashboard.riskSummary.unexpectedNetworkDestinations).toBe(1);
    expect(dashboard.findings.high).toBe(1);
    await rm(directory, { recursive: true, force: true });
  });
});

const run: RunRecord = {
  id: "run_summary",
  taskId: "task_summary",
  agentId: "agent_summary",
  runtimeProvider: "lima",
  status: "running",
  createdAt: new Date().toISOString(),
  repoPath: "/tmp/repo",
  command: ["agent"],
  environmentKeys: [],
  timeoutMs: 1000,
  expectedFiles: [],
  cleanupWorkspace: false
};

const finding: Finding = {
  id: "finding_network",
  taskId: run.taskId,
  runId: run.id,
  source: "intent_comparison",
  type: "network",
  severity: "high",
  title: "Unexpected network",
  description: "Unexpected network",
  status: "open",
  createdAt: new Date().toISOString()
};
