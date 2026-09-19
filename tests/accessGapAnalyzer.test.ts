import { describe, expect, it } from "vitest";
import { analyzeAccessGaps } from "../src/analysis/accessGapAnalyzer.js";
import type { AgentIntentDraft } from "../src/types.js";

const intent: AgentIntentDraft = {
  goal: "Fix session bug",
  interpretation: "Change session handling",
  expectedFiles: ["src/auth/session.ts", "tests/auth/**"],
  expectedNetwork: ["registry.npmjs.org"],
  expectedSecrets: ["NPM_TOKEN"],
  expectedMcpServers: ["github"],
  expectedTools: ["shell"],
  constraints: [],
};

describe("analyzeAccessGaps", () => {
  it("reports nothing when the permissions cover the plan", () => {
    const report = analyzeAccessGaps(intent, {
      filesystem: [{ path: "/workspace", access: "read_write" }],
      network: ["npmjs.org"],
      secrets: ["NPM_TOKEN"],
      mcpServers: ["github"],
      tools: ["shell"]
    });
    expect(report.gaps).toEqual([]);
    expect(report.verification).toBe("agent_reported");
  });

  it("flags files outside the writable folders, including read-only grants", () => {
    const report = analyzeAccessGaps(intent, {
      filesystem: [
        { path: "/workspace/src", access: "read" },
        { path: "/workspace/tests", access: "read_write" }
      ],
      network: ["registry.npmjs.org"],
      secrets: ["NPM_TOKEN"],
      mcpServers: ["github"]
    });
    expect(report.gaps.map((gap) => [gap.kind, gap.requested])).toEqual([["filesystem_write", "src/auth/session.ts"]]);
  });

  it("flags network, secrets, MCP and tools the plan needs but the scope denies", () => {
    const report = analyzeAccessGaps(intent, { filesystem: [{ path: "/workspace", access: "read_write" }], tools: ["filesystem"] });
    expect(report.gaps.map((gap) => gap.kind)).toEqual(["network", "secret", "mcp_server", "tool"]);
    expect(report.gaps.find((gap) => gap.kind === "network")?.enforcement).toBe("blocked");
    expect(report.gaps.find((gap) => gap.kind === "mcp_server")?.enforcement).toBe("not_enforced");
  });
});
