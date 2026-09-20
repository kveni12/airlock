import type { RequestAnalyzerRules } from "./request/requestRules.js";

export type { RequestAnalyzerRules };

export type RunStatus =
  | "pending"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type EventCategory =
  | "agent"
  | "filesystem"
  | "process"
  | "network"
  | "secret"
  | "mcp"
  | "git"
  | "policy"
  | "runtime";

export type EventSeverity = "info" | "low" | "medium" | "high" | "critical";
export type EvidenceSource = "runtime" | "filesystem" | "proxy" | "git" | "agent_reported" | "reviewer";
export type EvidenceVerification = "independent" | "agent_reported" | "inferred";

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
  evidenceSource?: EvidenceSource;
  verification?: EvidenceVerification;
  correlationId?: string;
}

export interface FilePermission {
  path: string;
  access: "read" | "read_write";
}

export interface PermissionSnapshot {
  filesystem?: FilePermission[];
  network?: string[];
  secrets?: string[];
  mcpServers?: Array<string | MCPServer>;
  tools?: string[];
}

export interface MCPServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse" | "other";
  tools?: string[];
  status: "available" | "connected" | "disabled";
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
  intent?: AgentIntentDraft;
  intentId?: string;
  requestId?: string;
  purpose?: "builder" | "planner" | "resolver";
  parentRunId?: string;
  projectId?: string;
  /**
   * Keep stdin open and allocate a TTY so a human can drive the agent's own CLI inside the
   * sandbox (`periscope codex`); Docker only. The run ends when the CLI exits.
   */
  interactive?: boolean;
}

/** A repo plus the saved sandbox settings New request starts from when the project is opened. */
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  branch?: string;
  /** Agent adapter kind (`claude_code`, `codex`, ...); undefined = shell command. */
  agentKind?: string;
  runtime: RuntimeProviderKind;
  scope: ProjectScope;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export interface ProjectScope {
  /** Paths relative to the repo ("/workspace" = whole repo) with the access the builder gets. */
  folders: FilePermission[];
  hosts: string[];
  secrets: string[];
  mcpServers: string[];
  tools: string[];
}

export type ProjectInput = Omit<Project, "id" | "createdAt" | "updatedAt" | "lastOpenedAt">;

export interface AgentIntentDraft {
  goal: string;
  summary?: string;
  interpretation?: string;
  /** Canonical list of planned actions. `plannedActions` is accepted as an alias on input. */
  plannedChanges?: string[];
  plannedActions?: string[];
  expectedFiles: string[];
  expectedDependencies?: string[];
  expectedCommands?: string[];
  expectedNetwork?: string[];
  expectedMcpServers?: string[];
  expectedTools?: string[];
  expectedSecrets?: string[];
  constraints: string[];
  assumptions?: string[];
  createdBy?: { agentId: string; agentType: string };
}

export type AlignmentStatus = "aligned" | "warning" | "conflict";

export interface IntentAlignment {
  status: AlignmentStatus;
  findingIds: string[];
  analyzedAt: string;
}

export interface IntentApproval {
  status: "approved" | "rejected";
  actor?: string;
  reason?: string;
  at: string;
}

export interface AgentIntent extends Omit<Required<AgentIntentDraft>, "createdBy"> {
  id: string;
  taskId: string;
  runId?: string;
  requestId?: string;
  planningRunId?: string;
  alignment?: IntentAlignment;
  approval?: IntentApproval;
  supersedes?: string;
  supersededBy?: string;
  createdBy: { agentId: string; agentType: string };
  createdAt: string;
}

export type AgentKind = "generic" | "codex" | "opencode" | "cursor" | "claude_code" | "devin" | "custom";

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

export type RuntimeProviderKind = "lima" | "docker" | "process";

export interface RuntimeConfig {
  /** `process` runs the agent unsandboxed as a local child process (demos/CI only; no isolation). */
  provider?: RuntimeProviderKind;
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
  runtimeProvider: RuntimeProviderKind;
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
  intentId?: string;
  requestId?: string;
  workspaceAccess?: "read_only" | "read_write";
  purpose?: "builder" | "planner" | "resolver";
  parentRunId?: string;
  projectId?: string;
  interactive?: boolean;
  /** Branch/PR created from this run's reviewed diff after human approval. */
  pullRequest?: RunPullRequest;
}

export interface RunPullRequest {
  branch: string;
  commit: string;
  baseHead?: string | null;
  pushed: boolean;
  remote?: string;
  url?: string;
  compareUrl?: string;
  createdAt: string;
  createdBy?: string;
}

export type FindingSource = "policy" | "intent_comparison" | "request_intent_comparison" | "reviewer";
export type FindingType =
  | "security"
  | "spec_drift"
  | "permission"
  | "network"
  | "dependency"
  | "tests"
  | "code_quality"
  | "sensitive_change"
  | "missing_action"
  | "constraint_violation"
  | "other";
/**
 * Where in the chain the drift happened:
 * request_drift — contradicts what the human asked (explicit constraint or forbidden resource);
 * plan_drift — differs from the agent's own declared intent;
 * permission_violation — exceeded the enforced/granted permission scope.
 */
export type FindingClassification = "request_drift" | "plan_drift" | "permission_violation";
export type FindingStatus = "open" | "resolving" | "re_reviewing" | "resolved" | "dismissed";

export interface FindingEvidence {
  eventIds?: string[];
  diffSnippet?: string;
  observedResource?: string;
  declaredResource?: string;
  requestId?: string;
  intentId?: string;
  humanRequestExcerpt?: string;
  agentIntentExcerpt?: string;
  /** Strongest verification backing this finding; absence-of-evidence findings are always inferred. */
  verification?: EvidenceVerification;
}

export interface Finding {
  id: string;
  taskId: string;
  /** Absent only for request/intent findings created before any run exists. */
  runId?: string;
  reviewId?: string;
  source: FindingSource;
  type: FindingType;
  classification?: FindingClassification;
  severity: EventSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidence?: FindingEvidence;
  status: FindingStatus;
  createdAt: string;
  resolvedAt?: string;
  dismissedAt?: string;
  dismissal?: { reason?: string; actor?: string };
}

export interface FileReview {
  path: string;
  status: "pending" | "reviewing" | "clean" | "finding";
  findingIds: string[];
}

export interface Review {
  id: string;
  taskId: string;
  runId: string;
  builderAgentId: string;
  reviewerAgentId: string;
  status: "pending" | "reviewing" | "needs_human" | "approved" | "rejected" | "failed";
  filesTotal: number;
  filesReviewed: number;
  cleanFiles: number;
  filesWithFindings: number;
  summary?: string;
  fileReviews: FileReview[];
  findingIds: string[];
  createdAt: string;
  completedAt?: string;
  approvedAt?: string;
  approval?: { actor?: string; reason?: string };
  rejectedAt?: string;
  rejection?: { actor?: string; reason?: string };
  failureReason?: string;
}

export interface ResolutionAttempt {
  id: string;
  findingId: string;
  taskId: string;
  originalRunId: string;
  resolutionRunId?: string;
  reviewId?: string;
  resolverAgentId: string;
  status: "pending" | "running" | "re_reviewing" | "resolved" | "failed";
  filesChanged: string[];
  resultingDiff?: string;
  testResult?: { passed: boolean; exitCode?: number | null; eventIds: string[] };
  reReviewResult?: { passed: boolean; summary: string };
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface BehaviorSummary {
  runId: string;
  filesModified: Array<{ resource: string; eventIds: string[] }>;
  dependencyChanges: Array<{ name: string; action: "dependency_added" | "dependency_removed"; eventIds: string[] }>;
  networkDestinations: Array<{ resource: string; allowed?: boolean; eventIds: string[] }>;
  secretsObserved: Array<{ resource: string; eventIds: string[] }>;
  mcpTools: Array<{ resource: string; server?: string; eventIds: string[]; verification: EvidenceVerification }>;
  commands: Array<{ resource: string; eventIds: string[]; exitCode?: number | null }>;
  tests: Array<{ command: string; passed?: boolean; eventIds: string[] }>;
}

/**
 * Additions an agent asks for mid-run when it discovers its declared intent is too narrow.
 * Every list is additive to the current intent / permission snapshot; nothing is removed.
 */
export interface IntentAmendmentChanges {
  plannedActions?: string[];
  expectedFiles?: string[];
  expectedDependencies?: string[];
  expectedCommands?: string[];
  expectedNetwork?: string[];
  expectedMcpServers?: string[];
  expectedTools?: string[];
  expectedSecrets?: string[];
}

export type IntentAmendmentStatus = "pending" | "approved" | "denied";

export interface IntentAmendment {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  /** Intent in force when the amendment was requested. */
  intentId?: string;
  /** Intent created by approving this amendment (supersedes `intentId`). */
  resultingIntentId?: string;
  requestId?: string;
  reason: string;
  changes: IntentAmendmentChanges;
  /** Extra capabilities requested alongside the plan change. */
  permissions: PermissionSnapshot;
  status: IntentAmendmentStatus;
  /** How the agent asked: control-channel HTTP call or a protocol line on stdout. */
  channel: "control_channel" | "agent_output";
  decision?: {
    actor?: string;
    reason?: string;
    at: string;
    /** Permission kinds that took effect in the live sandbox vs. those only recorded for the next run. */
    appliedLive: Array<keyof PermissionSnapshot>;
    deferred: Array<keyof PermissionSnapshot>;
  };
  createdAt: string;
}

export interface HumanRequest {
  id: string;
  taskId: string;
  runId?: string;
  rawPrompt: string;
  explicitConstraints?: string[];
  requestedObjectives?: string[];
  /** `manual`: the human reviewed/edited the extracted lists, so the prompt is not re-parsed for objectives/constraints. */
  analysisMode?: "rules" | "manual";
  context?: {
    attachments?: string[];
    metadata?: Record<string, unknown>;
  };
  /** Authenticated operator who recorded the request. */
  createdBy?: string;
  createdAt: string;
}

export type RequestProvenance = "explicit" | "inferred";

export type RequestResourceCategory =
  | "database"
  | "infrastructure"
  | "dependencies"
  | "network"
  | "secrets"
  | "tests"
  | "configuration"
  | "other";

export interface RequestStatement {
  text: string;
  provenance: RequestProvenance;
  source: "prompt" | "caller" | "analyzer";
  excerpt?: string;
}

export interface RequestResource {
  resource: string;
  category: RequestResourceCategory;
  provenance: RequestProvenance;
  excerpt: string;
}

export interface RequestAnalysis {
  id: string;
  requestId: string;
  objectives: RequestStatement[];
  explicitConstraints: RequestStatement[];
  inferredExpectations: RequestStatement[];
  explicitlyRequestedResources: RequestResource[];
  explicitlyForbiddenResources: RequestResource[];
  ambiguities: string[];
  analyzer: "deterministic";
  /** Revision of the editable rule set that produced this analysis (0 = built-in defaults). */
  rulesRevision?: number;
  createdAt: string;
}

export interface AlignmentSegment {
  status: AlignmentStatus;
  findingIds: string[];
  /** Why the segment has its status, or why it could not be evaluated. */
  detail: string;
}

/** Cheap, derived per-run verdict for list views. Not persisted. */
export interface RunVerdict {
  status: AlignmentStatus | "no_intent";
  openFindings: number;
  reviewStatus?: Review["status"];
}

export interface AlignmentSummary {
  runId: string;
  requestId?: string;
  intentId?: string;
  requestToIntent: AlignmentSegment;
  intentToBehavior: AlignmentSegment;
  behaviorToResult?: AlignmentSegment;
  counts: {
    constraintViolations: number;
    undeclaredFiles: number;
    undeclaredDependencies: number;
    undeclaredNetworkDestinations: number;
    undeclaredTools: number;
    missingExpectedActions: number;
  };
}

export interface ResultSummary {
  runId: string;
  status: RunStatus;
  exitCode?: number | null;
  failureReason?: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  dependenciesChanged: GitSummary["dependencyChanges"];
  commits: GitSummary["commits"];
  tests: Array<{ command: string; passed?: boolean; eventIds: string[]; verification: EvidenceVerification }>;
  review?: {
    reviewId: string;
    status: Review["status"];
    filesTotal: number;
    filesReviewed: number;
    filesWithFindings: number;
    findingIds: string[];
    approvedAt?: string;
    approval?: Review["approval"];
    rejectedAt?: string;
    rejection?: Review["rejection"];
  };
  findings: { total: number; open: number; resolved: number; dismissed: number };
  approvalStatus: "approved" | "rejected" | "needs_human" | "pending" | "not_reviewed";
}

export type TimelineEntryKind =
  | "human.request"
  | "request.analysis"
  | "agent.intent"
  | "intent.analysis"
  | "intent.approval"
  | "runtime"
  | "filesystem"
  | "process"
  | "network"
  | "mcp"
  | "git"
  | "agent"
  | "policy"
  | "finding.created"
  | "review"
  | "resolution"
  | "approval";

export interface TimelineEntry {
  id: string;
  timestamp: string;
  kind: TimelineEntryKind;
  actor: "human" | "agent" | "agentguard" | "runtime" | "reviewer" | "resolver";
  title: string;
  detail?: string;
  severity?: EventSeverity;
  evidenceSource?: EvidenceSource;
  verification?: EvidenceVerification;
  refs: {
    eventId?: string;
    requestId?: string;
    intentId?: string;
    findingId?: string;
    findingIds?: string[];
    reviewId?: string;
    resolutionId?: string;
    runId?: string;
  };
}

export type UserRole = "admin" | "operator";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** Absent for accounts that only sign in through Google. */
  salt?: string;
  passwordHash?: string;
  /** Google's stable account identifier, set once the account has signed in with Google. */
  googleSubject?: string;
  createdAt: string;
  lastLoginAt?: string;
}

/** A user without the credential material, safe to return from the API. */
export type PublicUser = Omit<User, "salt" | "passwordHash">;

export interface StoredData {
  runs: RunRecord[];
  users: User[];
  events: AgentEvent[];
  permissions: Record<string, PermissionSnapshot>;
  requests: HumanRequest[];
  requestAnalyses: RequestAnalysis[];
  intents: AgentIntent[];
  findings: Finding[];
  reviews: Review[];
  resolutions: ResolutionAttempt[];
  requestRules?: RequestAnalyzerRules;
  projects?: Project[];
  intentAmendments?: IntentAmendment[];
}

export type EventInput = Partial<Omit<AgentEvent, "id" | "timestamp">> &
  Pick<AgentEvent, "runId" | "taskId" | "agentId" | "category" | "action">;
