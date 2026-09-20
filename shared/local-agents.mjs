export const LOCAL_AGENTS = {
  codex: { name: "Codex", command: "codex", hosts: ["auth.openai.com", "chatgpt.com"] },
  claude_code: { name: "Claude Code", command: "claude", hosts: ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com"] }
};
export function localAgent(kind = "codex") {
  const agent = LOCAL_AGENTS[kind];
  if (!agent) throw new Error(`Unsupported local agent: ${kind}`);
  return agent;
}
