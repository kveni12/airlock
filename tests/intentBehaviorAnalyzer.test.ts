import { describe, expect, it } from "vitest";
import { IntentBehaviorAnalyzer } from "../src/analysis/intentBehaviorAnalyzer.js";
import type { AgentEvent, AgentIntent, EvidenceSource, EvidenceVerification, RunRecord } from "../src/types.js";

const analyzer = new IntentBehaviorAnalyzer();

describe("IntentBehaviorAnalyzer", () => {
  it("accepts expected files, dependencies, network, and commands without non-info findings", () => {
    const analysis = analyzer.analyze(run, intent(), [
      git("file_changed", "src/auth/session.ts"),
      fs("create", "/workspace/tests/auth/session.test.ts"),
      git("file_changed", "tests/auth/session.test.ts"),
      git("dependency_added", "passport-google-oauth20"),
      proxy("oauth.googleapis.com"),
      agent("process", "command_start", "npm test")
    ]);
    expect(analysis.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(analysis.observed.files.modified.map((file) => file.name)).toEqual(["src/auth/session.ts"]);
    expect(analysis.observed.files.created.map((file) => file.name)).toEqual(["tests/auth/session.test.ts"]);
    expect(analysis.observed.files.read).toEqual({ status: "unavailable", reason: expect.any(String) });
  });

  it("marks unexpected file, dependency, and network findings with independent verification and intent linkage", () => {
    const analysis = analyzer.analyze(run, intent(), [
      git("file_changed", "src/auth/session.ts"),
      git("file_changed", "infra/prod.tf"),
      git("dependency_added", "axios"),
      proxy("api.foo.com"),
      agent("process", "command_start", "npm test")
    ]);
    const drift = analysis.findings.filter((finding) => ["spec_drift", "dependency", "network"].includes(finding.type));
    expect(drift.map((finding) => finding.evidence?.observedResource)).toEqual(["infra/prod.tf", "axios", "api.foo.com"]);
    expect(drift.every((finding) => finding.evidence?.verification === "independent")).toBe(true);
    expect(drift.every((finding) => finding.evidence?.intentId === "intent_1" && finding.evidence?.requestId === "req_1")).toBe(true);
    expect(drift.every((finding) => finding.evidence?.eventIds?.length === 1)).toBe(true);
  });

  it("surfaces declared actions that were not observed as inferred, non-high findings", () => {
    const analysis = analyzer.analyze(run, intent({ expectedFiles: ["src/auth/session.ts", "tests/auth/session.test.ts"] }), [
      git("file_changed", "src/auth/session.ts")
    ]);
    const missing = analysis.findings.filter((finding) => finding.type === "missing_action");
    expect(missing.map((finding) => finding.title).sort()).toEqual(["Declared command not observed", "Expected file not modified"]);
    expect(missing.every((finding) => finding.evidence?.verification === "inferred")).toBe(true);
    expect(missing.every((finding) => ["info", "low", "medium"].includes(finding.severity))).toBe(true);
    const command = missing.find((finding) => finding.title === "Declared command not observed");
    expect(command?.severity).toBe("medium");
    expect(command?.evidence?.declaredResource).toBe("npm test");
    expect(analysis.observed.coverage.shellCommands).toBe("unavailable");
  });

  it("keeps agent-reported command, tool, and MCP evidence distinguishable from independent evidence", () => {
    const analysis = analyzer.analyze(run, intent({ expectedTools: ["filesystem", "shell"], expectedMcpServers: ["github"] }), [
      git("file_changed", "src/auth/session.ts"),
      agent("process", "command_start", "npm test"),
      agent("process", "command_start", "curl https://api.foo.com"),
      agent("agent", "tool_call", "web_fetch"),
      agent("agent", "tool_call", "bash"),
      agent("mcp", "tool_call", "slack/post_message")
    ]);
    const byTitle = (title: string) => analysis.findings.find((finding) => finding.title === title);
    expect(byTitle("Undeclared command executed")?.evidence?.observedResource).toBe("curl https://api.foo.com");
    expect(byTitle("Undeclared command executed")?.evidence?.verification).toBe("agent_reported");
    expect(byTitle("Undeclared tool used")?.evidence?.observedResource).toBe("web_fetch");
    expect(byTitle("Undeclared tool used")?.evidence?.verification).toBe("agent_reported");
    expect(byTitle("Unexpected MCP server used")?.evidence?.verification).toBe("agent_reported");
    expect(byTitle("Declared MCP server not observed")?.type).toBe("missing_action");
    expect(byTitle("Declared MCP server not observed")?.evidence?.verification).toBe("inferred");
    expect(analysis.observed.coverage).toMatchObject({
      filesystemWrites: "independent",
      filesystemReads: "unavailable",
      gitChanges: "independent",
      directSocketTraffic: "unavailable",
      shellCommands: "agent_reported",
      mcpCalls: "agent_reported"
    });
    expect(analysis.observed.tools.map((tool) => tool.name)).toEqual(["web_fetch", "bash"]);
  });
});

const run: RunRecord = {
  id: "run_1",
  taskId: "task_1",
  agentId: "builder_1",
  requestId: "req_1",
  runtimeProvider: "lima",
  status: "completed",
  createdAt: new Date().toISOString(),
  repoPath: "/tmp/repo",
  command: ["agent"],
  environmentKeys: [],
  timeoutMs: 1000,
  expectedFiles: [],
  cleanupWorkspace: false,
  gitSummary: { filesChanged: 1, insertions: 1, deletions: 0, files: [], commits: [], dependencyChanges: [] }
};

function intent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    id: "intent_1",
    taskId: "task_1",
    runId: "run_1",
    requestId: "req_1",
    goal: "Fix session bug",
    summary: "",
    interpretation: "",
    plannedChanges: ["Modify session.ts", "Add regression test", "Run tests"],
    plannedActions: ["Modify session.ts", "Add regression test", "Run tests"],
    expectedFiles: ["src/auth/session.ts", "tests/auth/**"],
    expectedDependencies: ["passport-google-oauth20"],
    expectedCommands: ["npm test"],
    expectedNetwork: ["oauth.googleapis.com"],
    expectedMcpServers: [],
    expectedTools: [],
    expectedSecrets: [],
    constraints: [],
    assumptions: [],
    createdBy: { agentId: "planner", agentType: "codex" },
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

let counter = 0;
function event(
  category: AgentEvent["category"],
  action: string,
  resource: string,
  evidenceSource: EvidenceSource,
  verification: EvidenceVerification
): AgentEvent {
  return {
    id: `evt_${++counter}`,
    runId: "run_1",
    taskId: "task_1",
    agentId: "builder_1",
    timestamp: new Date().toISOString(),
    category,
    action,
    resource,
    allowed: true,
    evidenceSource,
    verification
  };
}
const git = (action: string, resource: string) => event("git", action, resource, "git", "independent");
const fs = (action: string, resource: string) => event("filesystem", action, resource, "filesystem", "independent");
const proxy = (host: string) => event("network", "request", host, "proxy", "independent");
const agent = (category: AgentEvent["category"], action: string, resource: string) => event(category, action, resource, "agent_reported", "agent_reported");
