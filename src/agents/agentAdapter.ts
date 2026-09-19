import type { AgentProfile, CreateRunRequest } from "../types.js";

export interface ResolvedAgent {
  profile: AgentProfile;
  command: string[];
  environment: Record<string, string>;
}

export const AGENT_PROFILES = [
  {
    kind: "generic",
    description: "Runs any explicit non-interactive command supplied in the create-run request.",
    requiresCommand: true,
    supportsPrompt: false,
    executionModes: ["container_cli"]
  },
  {
    kind: "custom",
    description: "Runs an explicit command for a custom agent image or launcher.",
    requiresCommand: true,
    supportsPrompt: true,
    executionModes: ["container_cli", "bridge"]
  },
  {
    kind: "codex",
    description: "Resolves to a Codex CLI command when the selected runtime image contains a compatible codex executable.",
    requiresCommand: false,
    defaultBinary: "codex",
    supportsPrompt: true,
    executionModes: ["container_cli"]
  },
  {
    kind: "devin",
    description: "Runs an in-container Devin CLI or the included devin-agentguard-bridge for cloud-agent workflows.",
    requiresCommand: false,
    defaultBinary: "devin",
    bridgeBinary: "devin-agentguard-bridge",
    supportsPrompt: true,
    executionModes: ["container_cli", "bridge"]
  }
] as const;

export function resolveAgent(request: CreateRunRequest): ResolvedAgent {
  const profile: AgentProfile = request.agent ?? {
    kind: "generic",
    command: request.command
  };

  const command = profile.command ?? request.command ?? commandForProfile(profile);
  if (!command?.length) {
    throw new Error("Agent command is required. Provide command or agent.command.");
  }

  return {
    profile,
    command,
    environment: {
      ...(request.runtime?.env ?? {}),
      ...(profile.env ?? {}),
      AGENTGUARD_AGENT_KIND: profile.kind,
      AGENTGUARD_AGENT_ID: request.agentId,
      AGENTGUARD_TASK_ID: request.taskId,
      ...(profile.prompt ? { AGENTGUARD_PROMPT: profile.prompt } : {})
    }
  };
}

function commandForProfile(profile: AgentProfile): string[] {
  if (profile.kind === "codex") {
    return commandWithPrompt(profile.binary ?? "codex", ["exec", ...(profile.args ?? [])], profile.prompt);
  }

  if (profile.kind === "devin") {
    if (profile.executionMode === "bridge") {
      return commandWithPrompt(profile.binary ?? "devin-agentguard-bridge", [...(profile.args ?? [])], profile.prompt);
    }

    return commandWithPrompt(profile.binary ?? "devin", [...(profile.args ?? [])], profile.prompt);
  }

  throw new Error(`Agent profile '${profile.kind}' requires an explicit command.`);
}

function commandWithPrompt(binary: string, args: string[], prompt?: string): string[] {
  return prompt ? [binary, ...args, prompt] : [binary, ...args];
}
