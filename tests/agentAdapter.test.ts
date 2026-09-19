import { describe, expect, it } from "vitest";
import { resolveAgent } from "../src/agents/agentAdapter.js";
import type { CreateRunRequest } from "../src/types.js";

const baseRequest: CreateRunRequest = {
  taskId: "task_1",
  agentId: "agent_1",
  repo: { path: "/tmp/repo" },
  command: ["bash", "-lc", "echo hello"]
};

describe("resolveAgent", () => {
  it("uses top-level command as the universal generic adapter", () => {
    const agent = resolveAgent(baseRequest);

    expect(agent.profile.kind).toBe("generic");
    expect(agent.command).toEqual(["bash", "-lc", "echo hello"]);
    expect(agent.environment.AGENTGUARD_AGENT_KIND).toBe("generic");
  });

  it("uses explicit agent command overrides for custom agents", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: {
        kind: "custom",
        command: ["my-agent", "--non-interactive"],
        env: { AGENT_MODE: "ci" }
      }
    });

    expect(agent.command).toEqual(["my-agent", "--non-interactive"]);
    expect(agent.environment.AGENT_MODE).toBe("ci");
  });

  it("resolves a Codex profile to a container CLI command", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: {
        kind: "codex",
        prompt: "Implement OAuth login",
        args: ["--model", "gpt-5.6-terra"]
      }
    });

    expect(agent.command).toEqual(["codex", "exec", "--model", "gpt-5.6-terra", "Implement OAuth login"]);
    expect(agent.environment.AGENTGUARD_PROMPT).toBe("Implement OAuth login");
  });

  it("resolves a Devin bridge profile without assuming cloud sandbox visibility", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: {
        kind: "devin",
        executionMode: "bridge",
        prompt: "Fix tests"
      }
    });

    expect(agent.command).toEqual(["devin-agentguard-bridge", "Fix tests"]);
  });

  it("requires a command for generic/custom profiles", () => {
    expect(() =>
      resolveAgent({
        ...baseRequest,
        command: undefined,
        agent: { kind: "custom" }
      })
    ).toThrow("requires an explicit command");
  });
});
