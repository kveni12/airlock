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

  it("treats a permission rooted at /workspace as covering every workspace path", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { filesystem: [{ path: "/workspace", access: "read_write" }] },
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

describe("PolicyEngine read-only scope", () => {
  it("flags writes to paths that are only granted read access", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { filesystem: [{ path: "/workspace", access: "read" }, { path: "/workspace/tests", access: "read_write" }] }
    }));
    const base = { id: "e", runId: "r", taskId: "t", agentId: "a", timestamp: new Date().toISOString(), category: "filesystem" as const, action: "write" };
    const denied = await engine.evaluate({ ...base, resource: "/workspace/src/app.js" });
    expect(denied.map((event) => event.metadata?.rule)).toContain("permission_scope");
    const allowed = await engine.evaluate({ ...base, resource: "/workspace/tests/app.test.js" });
    expect(allowed.map((event) => event.metadata?.rule)).not.toContain("permission_scope");
  });

  it("lets a read-only subfolder narrow a writable parent (most specific grant wins)", async () => {
    const engine = new PolicyEngine(async () => ({
      permissions: { filesystem: [{ path: "/workspace", access: "read_write" }, { path: "/workspace/infra", access: "read" }] }
    }));
    const base = { id: "e", runId: "r", taskId: "t", agentId: "a", timestamp: new Date().toISOString(), category: "filesystem" as const, action: "write" };
    const denied = await engine.evaluate({ ...base, resource: "/workspace/infra/prod.tf" });
    expect(denied.map((event) => event.metadata?.rule)).toContain("permission_scope");
    const allowed = await engine.evaluate({ ...base, resource: "/workspace/src/app.js" });
    expect(allowed.map((event) => event.metadata?.rule)).not.toContain("permission_scope");
  });
});
