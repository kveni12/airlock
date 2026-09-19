import type {
  AgentEvent,
  AgentIntent,
  AgentIntentDraft,
  AgentProfile,
  CreateRunBody,
  DashboardSnapshot,
  Finding,
  FindingStatus,
  GenerateIntentBody,
  HumanRequest,
  PermissionSnapshot,
  RequestAnalysis,
  ResolutionAttempt,
  Review,
  RunDetail,
  RunFilesResponse,
  RunRecord,
  TimelineEntry
} from "./contracts";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_AGENTGUARD_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class AgentGuardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentGuardApiError";
  }
}

async function request<T>(path: string, signal?: AbortSignal, init?: { method?: "POST"; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      cache: "no-store",
      signal,
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch {
    throw new AgentGuardApiError(`Periscope backend is unavailable at ${API_BASE_URL}.`);
  }
  if (!response.ok) {
    let message = `Backend request failed: ${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // keep default message
    }
    throw new AgentGuardApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

function post<T>(path: string, body: unknown = {}) {
  return request<T>(path, undefined, { method: "POST", body });
}

const enc = encodeURIComponent;

export interface IntentAlignmentResponse {
  intentId: string;
  requestId: string | null;
  alignment: AgentIntent["alignment"] | null;
  approval: AgentIntent["approval"] | null;
  executionBlockReason: string | null;
  findings: Finding[];
}

// ---- health / runs ----

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  const result = await request<{ ok: boolean }>("/health", signal);
  return result.ok;
}

export async function listRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  return (await request<{ runs: RunRecord[] }>("/api/runs", signal)).runs;
}

export function getRun(runId: string, signal?: AbortSignal) {
  return request<RunRecord>(`/api/runs/${enc(runId)}`, signal);
}

export function stopRun(runId: string) {
  return post<RunRecord>(`/api/runs/${enc(runId)}/stop`);
}

export function createRun(body: CreateRunBody) {
  return post<{ runId: string; status: string }>("/api/runs", body);
}

export function getPermissions(runId: string, signal?: AbortSignal) {
  return request<PermissionSnapshot>(`/api/runs/${enc(runId)}/permissions`, signal);
}

export async function getEvents(runId: string, signal?: AbortSignal): Promise<AgentEvent[]> {
  return (await request<{ events: AgentEvent[] }>(`/api/runs/${enc(runId)}/events`, signal)).events;
}

export function getFiles(runId: string, signal?: AbortSignal) {
  return request<RunFilesResponse>(`/api/runs/${enc(runId)}/files`, signal);
}

export function getRunDetail(runId: string, signal?: AbortSignal) {
  return request<RunDetail>(`/api/runs/${enc(runId)}/detail`, signal);
}

export async function getTimeline(runId: string, signal?: AbortSignal): Promise<TimelineEntry[]> {
  return (await request<{ entries: TimelineEntry[] }>(`/api/runs/${enc(runId)}/timeline`, signal)).entries;
}

export async function getAgentProfiles(signal?: AbortSignal): Promise<AgentProfile[]> {
  return (await request<{ profiles: AgentProfile[] }>("/api/agent-profiles", signal)).profiles;
}

// ---- requests / intents ----

export function createRequest(body: { taskId: string; rawPrompt: string; explicitConstraints?: string[]; requestedObjectives?: string[] }) {
  return post<{ request: HumanRequest; analysis: RequestAnalysis }>("/api/requests", body);
}

export function getRequest(id: string, signal?: AbortSignal) {
  return request<HumanRequest>(`/api/requests/${enc(id)}`, signal);
}

export function getRequestAnalysis(id: string, signal?: AbortSignal) {
  return request<RequestAnalysis>(`/api/requests/${enc(id)}/analysis`, signal);
}

export function generateIntent(body: GenerateIntentBody) {
  return post<AgentIntent>("/api/intents/generate", body);
}

export function createIntent(body: AgentIntentDraft & { taskId: string; agentId?: string; agentType?: string; requestId?: string }) {
  return post<AgentIntent>("/api/intents", body);
}

export function getIntent(id: string, signal?: AbortSignal) {
  return request<AgentIntent>(`/api/intents/${enc(id)}`, signal);
}

export function getIntentAlignment(id: string, signal?: AbortSignal) {
  return request<IntentAlignmentResponse>(`/api/intents/${enc(id)}/alignment`, signal);
}

export function approveIntent(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<AgentIntent>(`/api/intents/${enc(id)}/approve`, body);
}

export function rejectIntent(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<AgentIntent>(`/api/intents/${enc(id)}/reject`, body);
}

export function reviseIntent(id: string, body: AgentIntentDraft & { agentId?: string; agentType?: string }) {
  return post<AgentIntent>(`/api/intents/${enc(id)}/revise`, body);
}

// ---- findings / reviews / resolutions ----

export async function listFindings(filter: { runId?: string; status?: FindingStatus; taskId?: string } = {}, signal?: AbortSignal): Promise<Finding[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return (await request<{ findings: Finding[] }>(`/api/findings${query ? `?${query}` : ""}`, signal)).findings;
}

export function dismissFinding(id: string, body: { reason?: string; actor?: string } = {}) {
  return post<Finding>(`/api/findings/${enc(id)}/dismiss`, body);
}

export function resolveFinding(id: string, body: { resolverAgentId?: string; strategy?: "revert_file" } = {}) {
  return post<ResolutionAttempt>(`/api/findings/${enc(id)}/resolve`, body);
}

export function getResolution(id: string, signal?: AbortSignal) {
  return request<ResolutionAttempt>(`/api/resolutions/${enc(id)}`, signal);
}

export function createReview(runId: string, body: { reviewerAgentId?: string } = {}) {
  return post<Review>(`/api/runs/${enc(runId)}/review`, body);
}

export async function listReviews(signal?: AbortSignal): Promise<Review[]> {
  return (await request<{ reviews: Review[] }>("/api/reviews", signal)).reviews;
}

export function getReview(id: string, signal?: AbortSignal) {
  return request<Review>(`/api/reviews/${enc(id)}`, signal);
}

export async function getReviewFindings(id: string, signal?: AbortSignal): Promise<Finding[]> {
  return (await request<{ findings: Finding[] }>(`/api/reviews/${enc(id)}/findings`, signal)).findings;
}

export function approveReview(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<Review>(`/api/reviews/${enc(id)}/approve`, body);
}

// ---- composed ----

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
  const source = new EventSource(`${API_BASE_URL}/api/runs/${enc(runId)}/stream`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as AgentEvent);
  const eventNames = ["runtime.started", "runtime.completed", "runtime.failed", "runtime.stopped", "runtime.telemetry_degraded", "process.start", "process.output", "process.exit", "process.command_start", "process.command_result", "filesystem.write", "filesystem.create", "filesystem.delete", "network.request", "secret.access", "mcp.tool_call", "mcp.tool_result", "git.file_changed", "git.diff_generated", "policy.violation", "agent.message", "agent.tool_call", "agent.tool_result"];
  for (const eventName of eventNames) source.addEventListener(eventName, (message) => onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent));
  source.onerror = () => onError?.();
  return () => source.close();
}
