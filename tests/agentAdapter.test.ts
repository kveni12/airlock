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

    expect(agent.command).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "--json",
      "--model",
      "gpt-5.6-terra",
      "Implement OAuth login"
    ]);
    expect(agent.environment.AGENTGUARD_PROMPT).toBe("Implement OAuth login");
    expect(agent.defaultBaseVm).toBe("agentguard-codex-base");
  });

  it("resolves Cursor to its non-interactive agent command", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: { kind: "cursor", prompt: "Fix the tests", args: ["--model", "auto"] }
    });

    expect(agent.command).toEqual([
      "agent",
      "-p",
      "--force",
      "--output-format",
      "stream-json",
      "--model",
      "auto",
      "Fix the tests"
    ]);
    expect(agent.defaultBaseVm).toBe("agentguard-cursor-base");
  });

  it("resolves Claude Code to a non-interactive, non-persistent command", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: { kind: "claude_code", prompt: "Refactor auth", args: ["--max-turns", "10"] }
    });

    expect(agent.command).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--max-turns",
      "10",
      "Refactor auth"
    ]);
    expect(agent.defaultBaseVm).toBe("agentguard-claude-code-base");
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
    expect(agent.defaultBaseVm).toBe("agentguard-devin-base");
  });

  it("supports a Devin CLI supplied by the caller", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: {
        kind: "devin",
        executionMode: "sandbox_cli",
        binary: "my-devin-cli",
        prompt: "Fix tests"
      }
    });

    expect(agent.command).toEqual(["my-devin-cli", "Fix tests"]);
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

  it("requires a prompt for named non-interactive adapters", () => {
    expect(() =>
      resolveAgent({
        ...baseRequest,
        command: undefined,
        agent: { kind: "claude_code" }
      })
    ).toThrow("agent.prompt is required");
  });
});
