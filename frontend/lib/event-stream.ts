import { API_BASE_URL } from "./api";
import type { AgentEvent } from "./contracts";

const eventNames = [
  "runtime.started", "runtime.completed", "runtime.failed", "runtime.stopped", "runtime.telemetry_degraded",
  "process.start", "process.output", "process.exit", "process.command_start", "process.command_result",
  "filesystem.write", "filesystem.create", "filesystem.delete", "network.request", "secret.access",
  "mcp.tool_call", "mcp.tool_result", "git.file_changed", "git.diff_generated", "policy.violation",
  "agent.message", "agent.tool_call", "agent.tool_result"
];

export function subscribeToRunEvents(runId: string, onEvent: (event: AgentEvent) => void, onError?: () => void): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/runs/${encodeURIComponent(runId)}/stream`);
  const receive = (message: MessageEvent) => onEvent(JSON.parse(message.data) as AgentEvent);
  source.onmessage = receive;
  for (const eventName of eventNames) source.addEventListener(eventName, receive as EventListener);
  source.onerror = () => onError?.();
  return () => source.close();
}
