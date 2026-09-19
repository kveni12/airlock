import type { AgentProfile, CreateRunRequest } from "../types.js";

export interface ResolvedAgent {
  profile: AgentProfile;
  command: string[];
  environment: Record<string, string>;
  defaultBaseVm: string;
}

export const AGENT_PROFILES = [
  {
    kind: "generic",
    displayName: "Generic command",
    description: "Runs any explicit non-interactive command supplied in the create-run request.",
    requiresCommand: true,
    supportsPrompt: false,
    executionModes: ["sandbox_cli"],
    defaultBaseVm: "agentguard-base",
    recommendedSecrets: []
  },
  {
    kind: "custom",
    displayName: "Custom coding agent",
    description: "Runs any explicit command for an agent CLI, SDK wrapper, ACP client, or remote bridge.",
    requiresCommand: true,
    supportsPrompt: true,
    executionModes: ["sandbox_cli", "bridge"],
    defaultBaseVm: "agentguard-base",
    recommendedSecrets: []
  },
  {
    kind: "codex",
    displayName: "OpenAI Codex",
    description: "Runs Codex CLI non-interactively inside the disposable sandbox VM.",
    requiresCommand: false,
    defaultBinary: "codex",
    supportsPrompt: true,
    executionModes: ["sandbox_cli"],
    defaultBaseVm: "agentguard-codex-base",
    recommendedSecrets: ["OPENAI_API_KEY"]
  },
  {
    kind: "cursor",
    displayName: "Cursor Agent",
    description: "Runs Cursor Agent CLI in non-interactive print mode inside the disposable sandbox VM.",
    requiresCommand: false,
    defaultBinary: "agent",
    supportsPrompt: true,
    executionModes: ["sandbox_cli"],
    defaultBaseVm: "agentguard-cursor-base",
    recommendedSecrets: ["CURSOR_API_KEY"]
  },
  {
    kind: "claude_code",
    displayName: "Claude Code",
    description: "Runs Claude Code in non-interactive print mode inside the disposable sandbox VM.",
    requiresCommand: false,
    defaultBinary: "claude",
    supportsPrompt: true,
    executionModes: ["sandbox_cli"],
    defaultBaseVm: "agentguard-claude-code-base",
    recommendedSecrets: ["ANTHROPIC_API_KEY"]
  },
  {
    kind: "devin",
    displayName: "Devin",
    description: "Runs a configured Devin API/CLI bridge and imports its resulting changes into the sandbox workspace.",
    requiresCommand: false,
    bridgeBinary: "devin-agentguard-bridge",
    supportsPrompt: true,
    executionModes: ["bridge", "sandbox_cli"],
    defaultBaseVm: "agentguard-devin-base",
    recommendedSecrets: ["DEVIN_API_KEY", "DEVIN_ORG_ID"]
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
    defaultBaseVm: profileDefinition(profile.kind).defaultBaseVm,
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
    return commandWithPrompt(
      profile.binary ?? "codex",
      ["exec", "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "--json", ...(profile.args ?? [])],
      requiredPrompt(profile)
    );
  }

  if (profile.kind === "cursor") {
    return commandWithPrompt(
      profile.binary ?? "agent",
      ["-p", "--force", "--output-format", "stream-json", ...(profile.args ?? [])],
      requiredPrompt(profile)
    );
  }

  if (profile.kind === "claude_code") {
    return commandWithPrompt(
      profile.binary ?? "claude",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--no-session-persistence",
        ...(profile.args ?? [])
      ],
      requiredPrompt(profile)
    );
  }

  if (profile.kind === "devin") {
    if (profile.executionMode === "sandbox_cli") {
      if (!profile.binary) throw new Error("A Devin sandbox_cli profile requires agent.binary.");
      return commandWithPrompt(profile.binary, [...(profile.args ?? [])], requiredPrompt(profile));
    }
    return commandWithPrompt(
      profile.binary ?? "devin-agentguard-bridge",
      [...(profile.args ?? [])],
      requiredPrompt(profile)
    );
  }

  throw new Error(`Agent profile '${profile.kind}' requires an explicit command.`);
}

function requiredPrompt(profile: AgentProfile): string {
  if (!profile.prompt?.trim()) {
    throw new Error(`agent.prompt is required for the '${profile.kind}' adapter unless agent.command is supplied.`);
  }
  return profile.prompt;
}

function profileDefinition(kind: AgentProfile["kind"]): (typeof AGENT_PROFILES)[number] {
  const definition = AGENT_PROFILES.find((candidate) => candidate.kind === kind);
  if (!definition) throw new Error(`Unsupported agent profile '${kind}'. Use kind 'custom' with an explicit command.`);
  return definition;
}

function commandWithPrompt(binary: string, args: string[], prompt?: string): string[] {
  return prompt ? [binary, ...args, prompt] : [binary, ...args];
}
