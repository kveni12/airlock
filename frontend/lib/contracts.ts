export type RunStatus = "pending" | "starting" | "running" | "completed" | "failed" | "stopping" | "stopped";
export type EventCategory = "agent" | "filesystem" | "process" | "network" | "secret" | "mcp" | "git" | "policy" | "runtime";
export type EventSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface AgentEvent {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  timestamp: string;
  category: EventCategory;
  action: string;
  resource?: string;
  allowed?: boolean;
  severity?: EventSeverity;
  metadata?: Record<string, unknown>;
}

export interface PermissionSnapshot {
  filesystem?: Array<{ path: string; access: "read" | "read_write" }>;
  network?: string[];
  secrets?: string[];
  mcpServers?: string[];
  tools?: string[];
}

export interface GitSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  commits: string[];
  dependencyChanges: Array<{ type: "dependency_added" | "dependency_removed"; name: string; manifest: string }>;
  diff?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  agentId: string;
  runtimeProvider: "lima" | "docker";
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  failureReason?: string;
  repoPath: string;
  repoBranch?: string;
  agent?: { kind: string; prompt?: string; executionMode?: string };
  command: string[];
  environmentKeys: string[];
  timeoutMs: number;
  expectedFiles: string[];
  cleanupWorkspace: boolean;
  gitSummary?: GitSummary;
}

export interface RunFilesResponse {
  runId: string;
  gitSummary: GitSummary | null;
  files: string[];
  diff: string | null;
}

export interface AgentProfile {
  kind: string;
  displayName: string;
  description: string;
  defaultBaseVm: string;
  runtimeReady: boolean;
  recommendedSecrets: readonly string[];
}

export interface DashboardSnapshot {
  runs: RunRecord[];
  permissionsByRun: Record<string, PermissionSnapshot>;
  eventsByRun: Record<string, AgentEvent[]>;
  filesByRun: Record<string, RunFilesResponse>;
}
