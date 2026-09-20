import type { RunDetail, RunInsightService } from "../dashboard/runInsightService.js";
import type { JsonStore } from "../store/jsonStore.js";
import type {
  AgentEvent,
  AlignmentStatus,
  Finding,
  FindingClassification,
  IntentAmendment,
  PermissionSnapshot,
  RunRecord,
  TimelineEntry
} from "../types.js";

/**
 * Run Manifest: one self-contained record of a run along the whole chain
 * request → intent (+ amendments) → permissions → observed behavior → result → human decision.
 * Derived on demand from canonical store state; nothing here is persisted.
 */
export interface RunManifest {
  version: 1;
  generatedAt: string;
  run: Pick<RunRecord, "id" | "taskId" | "agentId" | "agent" | "status" | "purpose" | "createdAt" | "startedAt" | "completedAt" | "exitCode" | "failureReason" | "repoPath" | "repoBranch" | "runtimeProvider" | "runtimeImage" | "projectId" | "parentRunId" | "pullRequest"> & {
    /** Whether the filesystem scope was enforced by the sandbox mounts or only observed after the fact. */
    filesystemEnforcement: "enforced" | "observed";
  };
  request?: {
    id: string;
    prompt: string;
    createdBy?: string;
    objectives: string[];
    explicitConstraints: string[];
    forbiddenResources: string[];
  };
  intent?: {
    id: string;
    goal: string;
    plannedActions: string[];
    expectedFiles: string[];
    expectedDependencies: string[];
    expectedCommands: string[];
    expectedNetwork: string[];
    constraints: string[];
    approval?: { status: "approved" | "rejected"; actor?: string; reason?: string; at: string };
    supersedes?: string;
  };
  amendments: Array<Pick<IntentAmendment, "id" | "reason" | "status" | "changes" | "permissions" | "channel" | "createdAt"> & { decidedAt?: string; decidedBy?: string }>;
  permissions: {
    granted: PermissionSnapshot;
    secretsInjected: string[];
  };
  behavior: {
    filesChanged: string[];
    insertions: number;
    deletions: number;
    commits: string[];
    dependencyChanges: Array<{ type: string; name: string; manifest?: string }>;
    commands: string[];
    tests: Array<{ command: string; passed?: boolean; verification: string }>;
    network: { allowed: string[]; blocked: string[] };
    writesPrevented: string[];
    mcpServers: string[];
  };
  alignment: {
    requestToIntent: AlignmentStatus;
    intentToBehavior: AlignmentStatus;
    behaviorToResult?: AlignmentStatus;
    detail: { requestToIntent: string; intentToBehavior: string; behaviorToResult?: string };
  };
  findings: {
    counts: Record<FindingClassification | "unclassified", number>;
    open: number;
    items: Array<Pick<Finding, "id" | "type" | "classification" | "severity" | "status" | "title" | "file">>;
  };
  decision: {
    status: "not_reviewed" | "pending" | "needs_human" | "approved" | "rejected";
    reviewId?: string;
    actor?: string;
    reason?: string;
    at?: string;
  };
  timeline: TimelineEntry[];
}

export class RunManifestService {
  constructor(
    private readonly store: JsonStore,
    private readonly insights: RunInsightService
  ) {}

  async build(runId: string): Promise<RunManifest> {
    const [detail, events, amendments, timeline] = await Promise.all([
      this.insights.detail(runId),
      this.store.getEvents(runId),
      this.store.listIntentAmendments(runId),
      this.insights.timeline(runId)
    ]);
    return buildManifest(detail, events, amendments, timeline);
  }
}

export function buildManifest(detail: RunDetail, events: AgentEvent[], amendments: IntentAmendment[], timeline: TimelineEntry[]): RunManifest {
  const { run, request, requestAnalysis, intent, permissions, result, alignment, findings, review } = detail;
  const enforcement = events.find((event) => event.category === "runtime" && event.action === "started")?.metadata?.filesystemScope;
  const network = events.filter((event) => event.category === "network");
  const uniq = (values: Array<string | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  const counts: RunManifest["findings"]["counts"] = { request_drift: 0, plan_drift: 0, permission_violation: 0, unclassified: 0 };
  for (const finding of findings) {
    if (finding.status === "dismissed") continue;
    counts[finding.classification ?? "unclassified"] += 1;
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      agent: run.agent,
      status: run.status,
      purpose: run.purpose,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      exitCode: run.exitCode,
      failureReason: run.failureReason,
      repoPath: run.repoPath,
      repoBranch: run.repoBranch,
      runtimeProvider: run.runtimeProvider,
      runtimeImage: run.runtimeImage,
      projectId: run.projectId,
      parentRunId: run.parentRunId,
      pullRequest: run.pullRequest,
      filesystemEnforcement: enforcement === "enforced" ? "enforced" : "observed"
    },
    request: request
      ? {
          id: request.id,
          prompt: request.rawPrompt,
          createdBy: request.createdBy,
          objectives: requestAnalysis?.objectives.map((o) => o.text) ?? [],
          explicitConstraints: requestAnalysis?.explicitConstraints.map((c) => c.text) ?? [],
          forbiddenResources: requestAnalysis?.explicitlyForbiddenResources.map((r) => r.resource) ?? []
        }
      : undefined,
    intent: intent
      ? {
          id: intent.id,
          goal: intent.goal,
          plannedActions: intent.plannedActions,
          expectedFiles: intent.expectedFiles,
          expectedDependencies: intent.expectedDependencies,
          expectedCommands: intent.expectedCommands,
          expectedNetwork: intent.expectedNetwork,
          constraints: intent.constraints,
          approval: intent.approval,
          supersedes: intent.supersedes
        }
      : undefined,
    amendments: amendments.map((amendment) => ({
      id: amendment.id,
      reason: amendment.reason,
      status: amendment.status,
      changes: amendment.changes,
      permissions: amendment.permissions,
      channel: amendment.channel,
      createdAt: amendment.createdAt,
      decidedAt: amendment.decision?.at,
      decidedBy: amendment.decision?.actor
    })),
    permissions: {
      granted: permissions ?? {},
      secretsInjected: run.environmentKeys.filter((key) => (permissions?.secrets ?? []).includes(key))
    },
    behavior: {
      filesChanged: result.filesChanged,
      insertions: result.insertions,
      deletions: result.deletions,
      commits: result.commits,
      dependencyChanges: result.dependenciesChanged.map((change) => ({ type: change.type, name: change.name, manifest: change.manifest })),
      commands: uniq(events.filter((event) => event.category === "process" && event.action === "command_start").map((event) => event.resource)),
      tests: result.tests.map((test) => ({ command: test.command, passed: test.passed, verification: test.verification })),
      network: {
        allowed: uniq(network.filter((event) => event.allowed !== false).map((event) => event.resource)),
        blocked: uniq(network.filter((event) => event.allowed === false).map((event) => event.resource))
      },
      writesPrevented: uniq(events.filter((event) => event.category === "filesystem" && event.action === "write_prevented").map((event) => event.resource)),
      mcpServers: uniq(events.filter((event) => event.category === "mcp").map((event) => event.resource))
    },
    alignment: {
      requestToIntent: alignment.requestToIntent.status,
      intentToBehavior: alignment.intentToBehavior.status,
      behaviorToResult: alignment.behaviorToResult?.status,
      detail: {
        requestToIntent: alignment.requestToIntent.detail,
        intentToBehavior: alignment.intentToBehavior.detail,
        behaviorToResult: alignment.behaviorToResult?.detail
      }
    },
    findings: {
      counts,
      open: findings.filter((finding) => ["open", "resolving", "re_reviewing"].includes(finding.status)).length,
      items: findings.map((finding) => ({
        id: finding.id,
        type: finding.type,
        classification: finding.classification,
        severity: finding.severity,
        status: finding.status,
        title: finding.title,
        file: finding.file
      }))
    },
    decision: {
      status: result.approvalStatus,
      reviewId: review?.id,
      actor: review?.approval?.actor ?? review?.rejection?.actor,
      reason: review?.approval?.reason ?? review?.rejection?.reason,
      at: review?.approvedAt ?? review?.rejectedAt
    },
    timeline
  };
}

const CLASSIFICATION_LABEL: Record<FindingClassification | "unclassified", string> = {
  request_drift: "request drift",
  plan_drift: "plan drift",
  permission_violation: "permission violation",
  unclassified: "other"
};

export function manifestToMarkdown(manifest: RunManifest): string {
  const { run, request, intent, amendments, permissions, behavior, alignment, findings, decision } = manifest;
  const list = (items: string[], empty = "none") => (items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`);
  const folders = permissions.granted.filesystem ?? [];
  const sections: string[] = [
    `# Run Manifest — ${run.id}`,
    "",
    `Agent **${run.agent?.kind ?? run.agentId}** · ${run.purpose ?? "builder"} · runtime ${run.runtimeProvider} · status **${run.status}**${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}`,
    `Repo \`${run.repoPath}\`${run.repoBranch ? ` @ ${run.repoBranch}` : ""} · ${run.createdAt}${run.completedAt ? ` → ${run.completedAt}` : ""}`,
    `Filesystem scope: ${run.filesystemEnforcement === "enforced" ? "enforced by read-only mounts" : "observed only (flagged after the fact)"}`,
    "",
    "## 1. Human request",
    request ? `> ${request.prompt.replace(/\n/g, "\n> ")}` : "_No request linked to this run._",
    ...(request ? ["", "Explicit constraints:", list(request.explicitConstraints), "Forbidden resources:", list(request.forbiddenResources)] : []),
    "",
    "## 2. Agent intent",
    intent ? `Goal: ${intent.goal}` : "_No intent declared._",
    ...(intent
      ? [
          "Planned actions:",
          list(intent.plannedActions),
          "Expected files:",
          list(intent.expectedFiles),
          `Human decision on plan: ${intent.approval ? `${intent.approval.status}${intent.approval.actor ? ` by ${intent.approval.actor}` : ""} at ${intent.approval.at}` : "none"}`
        ]
      : []),
    ...(amendments.length
      ? ["", "Amendments requested during the run:", ...amendments.map((a) => `- ${a.status}: ${a.reason}${a.decidedBy ? ` (decided by ${a.decidedBy})` : ""}`)]
      : []),
    "",
    "## 3. Permissions granted",
    `Files: ${folders.length ? folders.map((f) => `\`${f.path}\` (${f.access === "read_write" ? "can change" : "read-only"})`).join(", ") : "whole workspace"}`,
    `Network: ${permissions.granted.network?.length ? permissions.granted.network.join(", ") : "none (all egress denied)"}`,
    `Secrets injected: ${permissions.secretsInjected.length ? permissions.secretsInjected.join(", ") : "none"}`,
    `MCP servers: ${permissions.granted.mcpServers?.length ? permissions.granted.mcpServers.map((s) => (typeof s === "string" ? s : s.name)).join(", ") : "none"}`,
    "",
    "## 4. Observed behavior",
    `Files changed (${behavior.filesChanged.length}, +${behavior.insertions}/−${behavior.deletions}):`,
    list(behavior.filesChanged),
    "Writes prevented by the sandbox:",
    list(behavior.writesPrevented),
    "Commands:",
    list(behavior.commands),
    "Tests:",
    list(behavior.tests.map((t) => `${t.command} — ${t.passed === undefined ? "result unknown" : t.passed ? "passed" : "failed"} (${t.verification})`)),
    `Network: allowed ${behavior.network.allowed.length ? behavior.network.allowed.join(", ") : "none"}; blocked ${behavior.network.blocked.length ? behavior.network.blocked.join(", ") : "none"}`,
    "Dependency changes:",
    list(behavior.dependencyChanges.map((d) => `${d.type.replace("dependency_", "")} ${d.name}${d.manifest ? ` (${d.manifest})` : ""}`)),
    "",
    "## 5. Alignment",
    `- Request → Intent: **${alignment.requestToIntent}** — ${alignment.detail.requestToIntent}`,
    `- Intent → Behavior: **${alignment.intentToBehavior}** — ${alignment.detail.intentToBehavior}`,
    ...(alignment.behaviorToResult ? [`- Behavior → Result: **${alignment.behaviorToResult}** — ${alignment.detail.behaviorToResult}`] : []),
    "",
    `## 6. Findings (${findings.items.length}, ${findings.open} open)`,
    Object.entries(findings.counts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${count} ${CLASSIFICATION_LABEL[key as keyof typeof CLASSIFICATION_LABEL]}`)
      .join(", ") || "No active findings.",
    list(findings.items.map((f) => `[${f.severity}] ${f.title}${f.file ? ` (\`${f.file}\`)` : ""} — ${f.status}${f.classification ? `, ${CLASSIFICATION_LABEL[f.classification]}` : ""}`), "none"),
    "",
    "## 7. Human decision",
    `**${decision.status.replace("_", " ")}**${decision.actor ? ` by ${decision.actor}` : ""}${decision.at ? ` at ${decision.at}` : ""}${decision.reason ? ` — ${decision.reason}` : ""}`,
    ...(run.pullRequest ? ["", `Pull request branch: \`${run.pullRequest.branch}\`${run.pullRequest.url ? ` — ${run.pullRequest.url}` : ""}`] : []),
    "",
    `_Generated by Periscope at ${manifest.generatedAt}._`
  ];
  return sections.join("\n");
}
