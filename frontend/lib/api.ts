import type {
  AccessGapReport,
  AgentEvent,
  AgentIntent,
  AgentIntentDraft,
  AgentProfile,
  AuthStatus,
  CreateRunBody,
  DashboardSnapshot,
  Finding,
  FindingStatus,
  GenerateIntentBody,
  HumanRequest,
  PermissionSnapshot,
  Project,
  ProjectInput,
  PublicUser,
  RepoTreeListing,
  HostFolderListing,
  RuntimeSetupJob,
  RuntimeStatus,
  RequestAnalysis,
  RequestAnalyzerRules,
  ResolutionAttempt,
  Review,
  RunDetail,
  RunFilesResponse,
  RunRecord,
  IntentAmendment,
  RunPullRequest,
  TimelineEntry
} from "./contracts";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_AGENTGUARD_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class AgentGuardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentGuardApiError";
  }
}

async function request<T>(path: string, signal?: AbortSignal, init?: { method?: "POST" | "PUT" | "DELETE"; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      cache: "no-store",
      credentials: "include",
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
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { cache: "no-store", credentials: "include", signal });
  } catch {
    throw new AgentGuardApiError(`Periscope backend is unavailable at ${API_BASE_URL}.`);
  }
  if (!response.ok) throw new AgentGuardApiError(`Backend request failed: ${response.status} ${response.statusText}`, response.status);
  return response.text();
}

function post<T>(path: string, body: unknown = {}) {
  return request<T>(path, undefined, { method: "POST", body });
}

const enc = encodeURIComponent;

// ---- auth ----

export function getAuthStatus(signal?: AbortSignal) {
  return request<AuthStatus>("/api/auth/status", signal);
}

/** A full page navigation, not a fetch: the browser has to follow Google's redirects. */
export function googleSignInUrl(returnTo: string): string {
  return `${API_BASE_URL}/api/auth/google/start?returnTo=${enc(returnTo)}`;
}

export async function getCurrentUser(signal?: AbortSignal): Promise<PublicUser | null> {
  return (await request<{ user: PublicUser | null }>("/api/auth/me", signal)).user;
}

export async function login(email: string, password: string): Promise<PublicUser> {
  return (await post<{ user: PublicUser }>("/api/auth/login", { email, password })).user;
}

export async function bootstrapAdmin(body: { email: string; password: string; displayName?: string; setupToken: string }): Promise<PublicUser> {
  return (await post<{ user: PublicUser }>("/api/auth/bootstrap", body)).user;
}

export async function registerAccount(body: { email: string; password: string; displayName?: string }): Promise<PublicUser> {
  return (await post<{ user: PublicUser }>("/api/auth/register", body)).user;
}

export function logout() {
  return post<{ ok: boolean }>("/api/auth/logout");
}

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

export function getRunManifestMarkdown(runId: string, signal?: AbortSignal): Promise<string> {
  return requestText(`/api/runs/${enc(runId)}/manifest?format=markdown`, signal);
}

export function manifestDownloadUrl(runId: string) {
  return `${API_BASE_URL}/api/runs/${enc(runId)}/manifest?format=markdown`;
}

export function createPullRequestFromRun(runId: string, body: { branch?: string; push?: boolean; remote?: string; title?: string } = {}) {
  return post<RunPullRequest>(`/api/runs/${enc(runId)}/pull-request`, body);
}

export async function getTimeline(runId: string, signal?: AbortSignal): Promise<TimelineEntry[]> {
  return (await request<{ entries: TimelineEntry[] }>(`/api/runs/${enc(runId)}/timeline`, signal)).entries;
}

export async function getAgentProfiles(signal?: AbortSignal): Promise<AgentProfile[]> {
  return (await request<{ profiles: AgentProfile[] }>("/api/agent-profiles", signal)).profiles;
}

// ---- requests / intents ----

export function createRequest(body: { taskId: string; rawPrompt: string; explicitConstraints?: string[]; requestedObjectives?: string[]; analysisMode?: "rules" | "manual" }) {
  return post<{ request: HumanRequest; analysis: RequestAnalysis }>("/api/requests", body);
}

export function previewRequest(rawPrompt: string, rules?: RequestAnalyzerRules) {
  return post<RequestAnalysis>("/api/requests/preview", { rawPrompt, rules });
}

// ---- projects ----

export function getProjects(signal?: AbortSignal) {
  return request<Project[]>("/api/projects", signal);
}

export function getProject(id: string, signal?: AbortSignal) {
  return request<Project>(`/api/projects/${enc(id)}`, signal);
}

export function createProject(input: ProjectInput) {
  return post<Project>("/api/projects", input);
}

export function updateProject(id: string, input: ProjectInput) {
  return request<Project>(`/api/projects/${enc(id)}`, undefined, { method: "PUT", body: input });
}

export function openProject(id: string) {
  return post<Project>(`/api/projects/${enc(id)}/open`);
}

export function deleteProject(id: string) {
  return request<void>(`/api/projects/${enc(id)}`, undefined, { method: "DELETE" });
}

export function getRequestRules(signal?: AbortSignal) {
  return request<RequestAnalyzerRules>("/api/request-rules", signal);
}

export function updateRequestRules(rules: RequestAnalyzerRules) {
  return request<RequestAnalyzerRules>("/api/request-rules", undefined, { method: "PUT", body: rules });
}

export function resetRequestRules() {
  return post<RequestAnalyzerRules>("/api/request-rules/reset");
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

export function getHostFolders(dir?: string, signal?: AbortSignal) {
  return request<HostFolderListing>(`/api/host/folders${dir ? `?dir=${enc(dir)}` : ""}`, signal);
}

export async function pickHostFolder(startDir?: string): Promise<string | null> {
  return (await post<{ path: string | null }>("/api/host/pick-folder", { startDir })).path;
}

export function getRepoTree(repoPath: string, dir = "", signal?: AbortSignal) {
  return request<RepoTreeListing>(`/api/repo-tree?path=${enc(repoPath)}&dir=${enc(dir)}`, signal);
}

export function getRuntimeStatus(signal?: AbortSignal) {
  return request<RuntimeStatus>("/api/runtime/status", signal);
}

export function startRuntimeSetup(target: { provider: "docker" } | { provider: "lima"; agent?: string }) {
  return post<RuntimeSetupJob>("/api/runtime/setup", target);
}

export function getRuntimeSetupJob(id: string, signal?: AbortSignal) {
  return request<RuntimeSetupJob>(`/api/runtime/setup/${enc(id)}`, signal);
}

export function checkIntentAccess(id: string, permissions: PermissionSnapshot) {
  return request<AccessGapReport>(`/api/intents/${enc(id)}/access-check`, undefined, { method: "POST", body: { permissions } });
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

export function rejectReview(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<Review>(`/api/reviews/${enc(id)}/reject`, body);
}

// ---- composed ----

export async function loadAgentCapabilities(signal?: AbortSignal) {
  const runs = await listRuns(signal);
  const latestRuns = [...new Map(
    runs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((run) => [run.agentId, run])
  ).values()];
  const details = await Promise.all(latestRuns.map(async (run) => {
    const [permissions, events] = await Promise.all([
      getPermissions(run.id, signal),
      getEvents(run.id, signal)
    ]);
    return { runId: run.id, permissions, events };
  }));
  return {
    runs: latestRuns,
    permissionsByRun: Object.fromEntries(details.map((item) => [item.runId, item.permissions])),
    eventsByRun: Object.fromEntries(details.map((item) => [item.runId, item.events]))
  };
}

export async function loadAgentCapability(agentId: string, signal?: AbortSignal) {
  const runs = await listRuns(signal);
  const run = runs.filter((item) => item.agentId === agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return { run, permissions: run ? await getPermissions(run.id, signal) : null };
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
  const source = new EventSource(`${API_BASE_URL}/api/runs/${enc(runId)}/stream`, { withCredentials: true });
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as AgentEvent);
  const eventNames = ["runtime.started", "runtime.completed", "runtime.failed", "runtime.stopped", "runtime.telemetry_degraded", "process.start", "process.output", "process.exit", "process.command_start", "process.command_result", "filesystem.write", "filesystem.create", "filesystem.delete", "network.request", "secret.access", "mcp.tool_call", "mcp.tool_result", "git.file_changed", "git.diff_generated", "policy.violation", "agent.message", "agent.tool_call", "agent.tool_result"];
  for (const eventName of eventNames) source.addEventListener(eventName, (message) => onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent));
  source.onerror = () => onError?.();
  return () => source.close();
}

// ---- intent amendments ----

export async function listRunAmendments(runId: string, signal?: AbortSignal): Promise<IntentAmendment[]> {
  return (await request<{ amendments: IntentAmendment[] }>(`/api/runs/${enc(runId)}/intent-amendments`, signal)).amendments;
}

export function approveAmendment(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<IntentAmendment>(`/api/intent-amendments/${enc(id)}/approve`, body);
}

export function denyAmendment(id: string, body: { actor?: string; reason?: string } = {}) {
  return post<IntentAmendment>(`/api/intent-amendments/${enc(id)}/deny`, body);
}

export interface RunTreeEntry { name: string; path: string; kind: "file" | "dir"; access: "none" | "read" | "read_write" }
export function getRunTree(runId: string, dir = "", signal?: AbortSignal) {
  return request<{ dir: string; entries: RunTreeEntry[] }>(`/api/runs/${enc(runId)}/tree?dir=${enc(dir)}`, signal);
}

export function suggestProjectPermissions(repoPath: string, description: string, agentKind = "codex") {
  return post<{ scope: ProjectInput["scope"]; warnings: string[]; analysis: RequestAnalysis }>("/api/projects/suggest-permissions", { repoPath, description, agentKind });
}
export function validateLocalProject(input: ProjectInput) {
  return post<{ ok: boolean }>("/api/projects/validate-local", input);
}
