export type RunStatus =
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type EventCategory =
  | "filesystem"
  | "process"
  | "network"
  | "secret"
  | "mcp"
  | "git"
  | "policy"
  | "runtime";

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

export interface FilePermission {
  path: string;
  access: "read" | "read_write";
}

export interface PermissionSnapshot {
  filesystem?: FilePermission[];
  network?: string[];
  secrets?: string[];
  mcpServers?: string[];
  tools?: string[];
}

export interface CreateRunRequest {
  taskId: string;
  agentId: string;
  agent?: AgentProfile;
  repo: {
    path: string;
    branch?: string;
  };
  command?: string[];
  permissions?: PermissionSnapshot;
  expectedFiles?: string[];
  timeoutMs?: number;
  cleanupWorkspace?: boolean;
  runtime?: RuntimeConfig;
}

export type AgentKind = "generic" | "codex" | "cursor" | "claude_code" | "devin" | "custom";

export interface AgentProfile {
  kind: AgentKind;
  /**
   * Optional human intent/task prompt passed to adapters that support prompt-driven execution.
   */
  prompt?: string;
  /**
   * Full command override. This is the universal compatibility path for any agent.
   */
  command?: string[];
  /**
   * Extra arguments appended by a named adapter when command is not supplied.
   */
  args?: string[];
  /**
   * Agent executable name inside the selected runtime image.
   */
  binary?: string;
  /**
   * Non-secret environment values. Secret values must be injected by deployment/runtime config, not persisted here.
   */
  env?: Record<string, string>;
  /**
   * Records whether the agent runs locally inside the container or through an explicit bridge command.
   */
  executionMode?: "sandbox_cli" | "container_cli" | "bridge";
}

export interface RuntimeConfig {
  provider?: "lima" | "docker";
  /** Reusable Lima VM that is cloned for a run. */
  baseVm?: string;
  /** Docker image used only when provider is `docker`. */
  image?: string;
  env?: Record<string, string>;
}

export interface GitSummary {
  before?: {
    branch: string | null;
    head: string | null;
    dirty: boolean;
  };
  after?: {
    branch: string | null;
    head: string | null;
    dirty: boolean;
  };
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  commits: string[];
  dependencyChanges: DependencyChange[];
  diff?: string;
}

export interface DependencyChange {
  type: "dependency_added" | "dependency_removed";
  name: string;
  manifest: string;
  before?: string;
  after?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  agentId: string;
  containerId?: string | null;
  containerName?: string;
  sandboxId?: string | null;
  sandboxName?: string;
  runtimeProvider: "lima" | "docker";
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  failureReason?: string;
  repoPath: string;
  repoBranch?: string;
  agent?: AgentProfile;
  workspacePath?: string;
  command: string[];
  runtimeImage?: string;
  runtimeBaseVm?: string;
  environmentKeys: string[];
  timeoutMs: number;
  expectedFiles: string[];
  cleanupWorkspace: boolean;
  gitSummary?: GitSummary;
}

export interface StoredData {
  runs: RunRecord[];
  events: AgentEvent[];
  permissions: Record<string, PermissionSnapshot>;
}

export type EventInput = Partial<Omit<AgentEvent, "id" | "timestamp">> &
  Pick<AgentEvent, "runId" | "taskId" | "agentId" | "category" | "action">;
