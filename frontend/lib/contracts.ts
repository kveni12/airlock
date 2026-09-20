export type RunStatus = "pending" | "starting" | "running" | "paused" | "completed" | "failed" | "stopping" | "stopped";
export type EventCategory = "agent" | "filesystem" | "process" | "network" | "secret" | "mcp" | "git" | "policy" | "runtime";
export type EventSeverity = "info" | "low" | "medium" | "high" | "critical";
export type EvidenceSource = "runtime" | "filesystem" | "proxy" | "git" | "agent_reported" | "reviewer";
export type EvidenceVerification = "independent" | "agent_reported" | "inferred";
export type RuntimeProviderKind = "lima" | "docker" | "process";

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
  evidenceSource?: EvidenceSource;
  verification?: EvidenceVerification;
  metadata?: Record<string, unknown>;
}

export interface MCPServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse" | "other";
  tools?: string[];
  status: "available" | "connected" | "disabled";
}

export interface PermissionSnapshot {
  filesystem?: Array<{ path: string; access: "none" | "read" | "read_write" }>;
  network?: string[];
  secrets?: string[];
  mcpServers?: Array<string | MCPServer>;
  tools?: string[];
}

export interface DependencyChange {
  type: "dependency_added" | "dependency_removed";
  name: string;
  manifest: string;
}

export interface GitSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  commits: string[];
  dependencyChanges: DependencyChange[];
  diff?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  agentId: string;
  runtimeProvider: RuntimeProviderKind;
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
  intentId?: string;
  requestId?: string;
  workspaceAccess?: "read_only" | "read_write";
  workspaceMode?: "copy" | "local";
  purpose?: "builder" | "planner" | "resolver";
  parentRunId?: string;
  projectId?: string;
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

export interface ProjectScope {
  folders: Array<{ path: string; access: "none" | "read" | "read_write" }>;
  hosts: string[];
  secrets: string[];
  mcpServers: string[];
  tools: string[];
}

/** A repo plus the saved sandbox settings New request starts from when the project is opened. */
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  branch?: string;
  agentKind?: string;
  runtime: RuntimeProviderKind;
  scope: ProjectScope;
  notes?: string;
  humanIntent?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type ProjectInput = Omit<Project, "id" | "createdAt" | "updatedAt" | "lastOpenedAt">;

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
  recommendedHosts: readonly string[];
}

export interface DashboardSnapshot {
  runs: RunRecord[];
  permissionsByRun: Record<string, PermissionSnapshot>;
  eventsByRun: Record<string, AgentEvent[]>;
  filesByRun: Record<string, RunFilesResponse>;
}

// ---- Intent observability ----

export type AccessGapKind = "filesystem_write" | "network" | "secret" | "mcp_server" | "tool";
export interface AccessGap {
  kind: AccessGapKind;
  requested: string;
  reason: string;
  enforcement: "blocked" | "flagged" | "not_enforced";
}
export interface AccessGapReport {
  gaps: AccessGap[];
  verification: "agent_reported";
}

export interface RepoTreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface RepoTreeListing {
  repoPath: string;
  dir: string;
  entries: RepoTreeEntry[];
}

export interface HostFolderEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface HostFolderListing {
  dir: string;
  parent: string | null;
  home: string;
  isGitRepo: boolean;
  entries: HostFolderEntry[];
  nativeDialog: boolean;
}

export interface RuntimeStatus {
  docker: { available: boolean; image: string; imagePresent: boolean; detail?: string };
  lima: { available: boolean; baseVm: string; baseVmPresent: boolean; agentVms: Record<string, { vm: string; present: boolean }>; detail?: string };
  process: { available: true; sandboxed: false };
}

export interface RuntimeSetupJob {
  id: string;
  target: { provider: "docker" } | { provider: "lima"; agent?: string };
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  log: string[];
}

export type AlignmentStatus = "aligned" | "warning" | "conflict";
export type RequestProvenance = "explicit" | "inferred";

export interface HumanRequest {
  id: string;
  taskId: string;
  runId?: string;
  rawPrompt: string;
  explicitConstraints?: string[];
  requestedObjectives?: string[];
  analysisMode?: "rules" | "manual";
  context?: { attachments?: string[]; metadata?: Record<string, unknown> };
  createdBy?: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "operator";
  createdAt: string;
  lastLoginAt?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  needsBootstrap: boolean;
  googleEnabled?: boolean;
  openSignup?: boolean;
}

export type LexiconCategory = "database" | "infrastructure" | "dependencies" | "network" | "secrets" | "tests" | "configuration";

export interface RequestAnalyzerRules {
  revision: number;
  updatedAt: string;
  prohibitionPatterns: string[];
  hedgePatterns: Array<{ pattern: string; label: string }>;
  imperativeVerbs: string[];
  resourceLexicon: Record<LexiconCategory, string[]>;
  inferredExpectations: Array<{ when: string; text: string }>;
}

export interface RequestStatement {
  text: string;
  provenance: RequestProvenance;
  source: "prompt" | "caller" | "analyzer";
  excerpt?: string;
}

export interface RequestResource {
  resource: string;
  category: string;
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
  rulesRevision?: number;
  createdAt: string;
}

export interface AgentIntentDraft {
  goal: string;
  summary?: string;
  interpretation?: string;
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
}

export interface AgentIntent {
  id: string;
  taskId: string;
  runId?: string;
  requestId?: string;
  planningRunId?: string;
  goal: string;
  summary: string;
  interpretation: string;
  plannedChanges: string[];
  plannedActions: string[];
  expectedFiles: string[];
  expectedDependencies: string[];
  expectedCommands: string[];
  expectedNetwork: string[];
  expectedMcpServers: string[];
  expectedTools: string[];
  expectedSecrets: string[];
  constraints: string[];
  assumptions: string[];
  alignment?: { status: AlignmentStatus; findingIds: string[]; analyzedAt: string };
  approval?: { status: "approved" | "rejected"; actor?: string; reason?: string; at: string };
  supersedes?: string;
  supersededBy?: string;
  createdBy: { agentId: string; agentType: string };
  createdAt: string;
}

export type FindingSource = "policy" | "intent_comparison" | "request_intent_comparison" | "reviewer";
export type FindingStatus = "open" | "resolving" | "re_reviewing" | "resolved" | "dismissed";

export type FindingClassification = "request_drift" | "plan_drift" | "permission_violation";

export interface Finding {
  id: string;
  taskId: string;
  runId?: string;
  reviewId?: string;
  source: FindingSource;
  type: string;
  classification?: FindingClassification;
  severity: EventSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidence?: {
    eventIds?: string[];
    diffSnippet?: string;
    observedResource?: string;
    declaredResource?: string;
    requestId?: string;
    intentId?: string;
    humanRequestExcerpt?: string;
    agentIntentExcerpt?: string;
    verification?: EvidenceVerification;
  };
  status: FindingStatus;
  createdAt: string;
  resolvedAt?: string;
  dismissedAt?: string;
  dismissal?: { reason?: string; actor?: string };
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
  fileReviews: Array<{ path: string; status: "pending" | "reviewing" | "clean" | "finding"; findingIds: string[] }>;
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

export type CoverageLevel = EvidenceVerification | "unavailable";

export interface Unavailable {
  status: "unavailable";
  reason: string;
}

export interface ObservedItem {
  name: string;
  eventIds: string[];
  verification: EvidenceVerification;
}

export interface ObservedBehavior {
  runId: string;
  files: { read: Unavailable; modified: ObservedItem[]; created: ObservedItem[]; deleted: ObservedItem[] };
  commands: Array<ObservedItem & { exitCode?: number | null }>;
  tests: Array<ObservedItem & { passed?: boolean }>;
  dependenciesAdded: ObservedItem[];
  dependenciesRemoved: ObservedItem[];
  networkDestinations: Array<ObservedItem & { allowed?: boolean }>;
  secrets: ObservedItem[] | Unavailable;
  mcpCalls: Array<ObservedItem & { server?: string }>;
  tools: ObservedItem[];
  coverage: Record<string, CoverageLevel>;
}

export interface AlignmentSegment {
  status: AlignmentStatus;
  findingIds: string[];
  detail: string;
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
  dependenciesChanged: DependencyChange[];
  commits: string[];
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

export interface TimelineEntry {
  id: string;
  timestamp: string;
  kind: string;
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

export interface RunDetail {
  run: RunRecord;
  request?: HumanRequest;
  requestAnalysis?: RequestAnalysis;
  intent?: AgentIntent;
  permissions?: PermissionSnapshot;
  behaviorSummary?: ObservedBehavior;
  result: ResultSummary;
  alignment: AlignmentSummary;
  findings: Finding[];
  review?: Review;
  resolutions: ResolutionAttempt[];
}

export interface AgentProfileConfig {
  kind: string;
  prompt?: string;
  binary?: string;
  args?: string[];
  command?: string[];
}

export interface CreateRunBody {
  taskId: string;
  agentId: string;
  repo: { path: string; branch?: string };
  agent?: AgentProfileConfig;
  command?: string[];
  permissions?: PermissionSnapshot;
  expectedFiles?: string[];
  timeoutMs?: number;
  runtime?: { provider: RuntimeProviderKind };
  intent?: AgentIntentDraft;
  intentId?: string;
  requestId?: string;
  projectId?: string;
}

export interface GenerateIntentBody {
  taskId: string;
  agentId: string;
  requestId?: string;
  projectId?: string;
  repo?: { path: string; branch?: string };
  agent?: AgentProfileConfig;
  command?: string[];
  permissions?: PermissionSnapshot;
  runtime?: { provider: RuntimeProviderKind };
  timeoutMs?: number;
  structuredOutput?: unknown;
}

export type IntentAmendmentStatus = "pending" | "approved" | "denied";

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

/** A mid-run request from the agent to change its plan and/or gain extra access; the run pauses until decided. */
export interface IntentAmendment {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  intentId?: string;
  resultingIntentId?: string;
  requestId?: string;
  reason: string;
  changes: IntentAmendmentChanges;
  permissions: PermissionSnapshot;
  status: IntentAmendmentStatus;
  channel: "control_channel" | "agent_output";
  decision?: {
    actor?: string;
    reason?: string;
    at: string;
    appliedLive: Array<keyof PermissionSnapshot>;
    deferred: Array<keyof PermissionSnapshot>;
  };
  createdAt: string;
}
