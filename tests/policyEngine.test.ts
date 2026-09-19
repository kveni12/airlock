import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import type { AgentEvent } from "../src/types.js";

const baseEvent: AgentEvent = {
  id: "evt_1",
  runId: "run_1",
  taskId: "task_1",
  agentId: "agent_1",
  timestamp: new Date().toISOString(),
  category: "filesystem",
  action: "write",
  resource: "/workspace/src/app.js",
  allowed: true
};

describe("PolicyEngine", () => {
  it("does not flag expected allowed files", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { filesystem: [{ path: "/workspace/src", access: "read_write" }] },
      expectedFiles: ["src/app.js"]
    }));

    await expect(engine.evaluate(baseEvent)).resolves.toHaveLength(0);
  });

  it("flags unexpected and sensitive file changes", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { filesystem: [{ path: "/workspace/src", access: "read_write" }] },
      expectedFiles: ["src/app.js"]
    }));

    const violations = await engine.evaluate({ ...baseEvent, resource: "/workspace/config/secrets.json" });
    expect(violations.map((event) => event.metadata?.rule)).toEqual(
      expect.arrayContaining(["unexpected_file_change", "sensitive_file_change", "permission_scope"])
    );
  });

  it("flags disallowed network hosts", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { network: ["api.github.com"] }
    }));

    const violations = await engine.evaluate({
      ...baseEvent,
      category: "network",
      action: "request",
      resource: "example.com"
    });

    expect(violations[0].metadata?.rule).toBe("network_scope");
  });
});
