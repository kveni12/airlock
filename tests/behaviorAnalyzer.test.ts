import { describe, expect, it } from "vitest";
import { BehaviorAnalyzer } from "../src/analysis/behaviorAnalyzer.js";
import type { AgentEvent, AgentIntent, RunRecord } from "../src/types.js";

describe("BehaviorAnalyzer", () => {
  it("accepts expected files, dependencies, and network destinations", () => {
    const analysis = new BehaviorAnalyzer().analyze(run, intent, [
      event("git", "file_changed", "src/auth/oauth.ts"),
      event("git", "dependency_added", "passport-google-oauth20"),
      event("network", "request", "oauth.googleapis.com"),
      event("process", "command_start", "npm test")
    ]);
    expect(analysis.findings.filter((finding) => finding.severity !== "info")).toHaveLength(0);
  });

  it("creates traceable findings for unexpected file, dependency, and network activity", () => {
    const analysis = new BehaviorAnalyzer().analyze(run, intent, [
      event("git", "file_changed", "infra/prod.tf"),
      event("git", "dependency_added", "axios"),
      event("network", "request", "unknown-service.example"),
      event("process", "command_start", "npm test")
    ]);
    expect(analysis.findings.map((finding) => finding.type)).toEqual(["spec_drift", "dependency", "network"]);
    expect(analysis.findings.every((finding) => finding.evidence?.eventIds?.length === 1)).toBe(true);
    expect(analysis.findings[0].evidence?.observedResource).toBe("infra/prod.tf");
  });
});

const run: RunRecord = {
  id: "run_1",
  taskId: "task_1",
  agentId: "builder_1",
  runtimeProvider: "lima",
  status: "completed",
  createdAt: new Date().toISOString(),
  repoPath: "/tmp/repo",
  command: ["agent"],
  environmentKeys: [],
  timeoutMs: 1000,
  expectedFiles: [],
  cleanupWorkspace: false,
  gitSummary: {
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    files: [],
    commits: [],
    dependencyChanges: []
  }
};

const intent: AgentIntent = {
  id: "intent_1",
  taskId: "task_1",
  runId: "run_1",
  goal: "Add OAuth",
  summary: "OAuth implementation",
  plannedChanges: ["Add OAuth"],
  plannedActions: ["Add OAuth"],
  interpretation: "",
  expectedCommands: [],
  expectedTools: [],
  assumptions: [],
  expectedFiles: ["src/auth/**", "tests/auth/**"],
  expectedDependencies: ["passport-google-oauth20"],
  expectedNetwork: ["oauth.googleapis.com"],
  expectedMcpServers: [],
  expectedSecrets: ["GOOGLE_CLIENT_SECRET"],
  constraints: ["No infrastructure changes"],
  createdBy: { agentId: "builder_1", agentType: "codex" },
  createdAt: new Date().toISOString()
};

function event(category: AgentEvent["category"], action: string, resource: string): AgentEvent {
  return {
    id: `evt_${category}_${action}_${resource}`,
    runId: "run_1",
    taskId: "task_1",
    agentId: "builder_1",
    timestamp: new Date().toISOString(),
    category,
    action,
    resource,
    allowed: true
  };
}
