import type { AgentEvent, AgentProfile, DashboardSnapshot, PermissionSnapshot, RunFilesResponse, RunRecord } from "./contracts";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_AGENTGUARD_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class AgentGuardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentGuardApiError";
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { cache: "no-store", signal });
  } catch {
    throw new AgentGuardApiError(`AgentGuard backend is unavailable at ${API_BASE_URL}.`);
  }
  if (!response.ok) throw new AgentGuardApiError(`Backend request failed: ${response.status} ${response.statusText}`, response.status);
  return response.json() as Promise<T>;
}

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  const result = await request<{ ok: boolean }>("/health", signal);
  return result.ok;
}

export async function listRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  return (await request<{ runs: RunRecord[] }>("/api/runs", signal)).runs;
}

export function getRun(runId: string, signal?: AbortSignal) {
  return request<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`, signal);
}

export function getPermissions(runId: string, signal?: AbortSignal) {
  return request<PermissionSnapshot>(`/api/runs/${encodeURIComponent(runId)}/permissions`, signal);
}

export async function getEvents(runId: string, signal?: AbortSignal): Promise<AgentEvent[]> {
  return (await request<{ events: AgentEvent[] }>(`/api/runs/${encodeURIComponent(runId)}/events`, signal)).events;
}

export function getFiles(runId: string, signal?: AbortSignal) {
  return request<RunFilesResponse>(`/api/runs/${encodeURIComponent(runId)}/files`, signal);
}

export async function getAgentProfiles(signal?: AbortSignal): Promise<AgentProfile[]> {
  return (await request<{ profiles: AgentProfile[] }>("/api/agent-profiles", signal)).profiles;
}

export async function loadDashboardSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
  const runs = await listRuns(signal);
  const details = await Promise.all(runs.map(async (run) => {
    const [permissions, events, files] = await Promise.all([
      getPermissions(run.id, signal),
      getEvents(run.id, signal),
      getFiles(run.id, signal)
    ]);
    return { runId: run.id, permissions, events, files };
  }));
  return {
    runs,
    permissionsByRun: Object.fromEntries(details.map((item) => [item.runId, item.permissions])),
    eventsByRun: Object.fromEntries(details.map((item) => [item.runId, item.events])),
    filesByRun: Object.fromEntries(details.map((item) => [item.runId, item.files]))
  };
}

export function subscribeToRun(runId: string, onEvent: (event: AgentEvent) => void, onError?: () => void): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/runs/${encodeURIComponent(runId)}/stream`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as AgentEvent);
  const eventNames = ["runtime.started", "runtime.completed", "runtime.failed", "runtime.stopped", "runtime.telemetry_degraded", "process.start", "process.output", "process.exit", "process.command_start", "process.command_result", "filesystem.write", "filesystem.create", "filesystem.delete", "network.request", "secret.access", "mcp.tool_call", "mcp.tool_result", "git.file_changed", "git.diff_generated", "policy.violation", "agent.message", "agent.tool_call", "agent.tool_result"];
  for (const eventName of eventNames) source.addEventListener(eventName, (message) => onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent));
  source.onerror = () => onError?.();
  return () => source.close();
}

