export interface LocalAgent { name: string; command: string; hosts: string[] }
export const LOCAL_AGENTS: Record<"codex" | "claude_code", LocalAgent>;
export function localAgent(kind?: string): LocalAgent;
