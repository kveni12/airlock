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

    expect(agent.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(agent.command[2]).toContain('printenv OPENAI_API_KEY | "$0" login --with-api-key');
    expect(agent.command[2]).not.toMatch(/sk-/);
    expect(agent.command.slice(3)).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "--model",
      "gpt-5.6-terra",
      "Implement OAuth login"
    ]);
    expect(agent.environment.AGENTGUARD_PROMPT).toBe("Implement OAuth login");
    expect(agent.defaultBaseVm).toBe("agentguard-codex-base");
  });

  it("resolves OpenCode to an auto-approved JSON streaming command", () => {
    const agent = resolveAgent({
      ...baseRequest,
      command: undefined,
      agent: {
        kind: "opencode",
        prompt: "Implement OAuth login",
        args: ["--model", "openai/gpt-5"]
      }
    });

    expect(agent.command).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--auto",
      "--model",
      "openai/gpt-5",
      "Implement OAuth login"
    ]);
    expect(agent.environment.AGENTGUARD_AGENT_KIND).toBe("opencode");
    expect(agent.environment.AGENTGUARD_PROMPT).toBe("Implement OAuth login");
    expect(agent.defaultBaseVm).toBe("agentguard-opencode-base");
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

  it("pins Claude Code to an Anthropic workspace via header when the host configures one", () => {
    const request: CreateRunRequest = { ...baseRequest, command: undefined, agent: { kind: "claude_code", prompt: "x" } };
    const hostEnv = { ANTHROPIC_WORKSPACE_ID: " wrkspc_123 ", ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-o" };

    const claude = resolveAgent(request, hostEnv);
    expect(claude.environment.ANTHROPIC_CUSTOM_HEADERS).toBe("anthropic-workspace-id: wrkspc_123");
    expect(Object.values(claude.environment)).not.toContain("sk-ant-secret");
    expect(claude.environment).not.toHaveProperty("ANTHROPIC_API_KEY");

    expect(resolveAgent(request, {}).environment).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    const codex = resolveAgent({ ...request, agent: { kind: "codex", prompt: "x" } }, hostEnv);
    expect(codex.environment).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
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
