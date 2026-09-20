"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowDown, ArrowLeft, FileText, GitPullRequestArrow, PanelsTopLeft, RefreshCw } from "lucide-react";
import { approveIntent, approveReview, createPullRequestFromRun, createReview, getRunDetail, getTimeline, rejectIntent, rejectReview, stopRun } from "@/lib/api";
import type { AgentIntent, AlignmentSegment, Finding, HumanRequest, ObservedBehavior, ObservedItem, PermissionSnapshot, RequestAnalysis, ResultSummary, RunDetail as RunDetailModel, TimelineEntry } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { groupFindings, violatedResources } from "@/lib/findings";
import { FindingGroups } from "./finding-groups";
import { ActionButton, AlignmentBadge, Chips, Empty, ErrorBanner, KeyValue, RunStatusBadge, Section, SeverityBadge, VerificationBadge, formatDateTime, formatTime, verificationHelp } from "./ui";

const ACTIVE = ["pending", "starting", "running", "paused", "stopping"];

export function RunDetail({ runId }: { runId: string }) {
  const loadDetail = useCallback((signal: AbortSignal) => getRunDetail(runId, signal), [runId]);
  const loadTimeline = useCallback((signal: AbortSignal) => getTimeline(runId, signal), [runId]);
  const detail = useResource(loadDetail);
  const timeline = useResource(loadTimeline, 6000);
  const [tab, setTab] = useState<"chain" | "findings" | "timeline">("chain");

  const refreshAll = async () => { await Promise.all([detail.refresh(), timeline.refresh()]); };

  if (detail.error && !detail.data) return <div className="mx-auto max-w-6xl space-y-4"><Back /><ErrorBanner message={detail.error} onRetry={detail.refresh} /></div>;
  if (!detail.data) return <div className="mx-auto max-w-6xl space-y-4"><Back /><div className="skeleton h-40" /><div className="skeleton h-80" /></div>;

  const d = detail.data;
  const { run } = d;
  const openFindings = d.findings.filter((f) => f.status === "open");
  const findingGroups = groupFindings(d.findings);
  const violations = violatedResources(d.findings);

  return <div className="mx-auto max-w-6xl space-y-6">
    <Back />
    {detail.error && <ErrorBanner message={detail.error} onRetry={detail.refresh} />}
    <header className="card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2"><RunStatusBadge status={run.status} /><span className="status capitalize">{run.purpose ?? "builder"}</span>{run.workspaceAccess === "read_only" && <span className="status status-muted">read-only workspace</span>}<span className="mono text-xs text-[#64717c]">{run.runtimeProvider}</span></div>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-.04em]">{run.taskId}</h1>
          <p className="mono mt-1 text-xs text-[#64717c]">{run.id} · agent {run.agentId} · {formatDateTime(run.createdAt)}{run.completedAt && ` → ${formatTime(run.completedAt)}`}{run.exitCode != null && ` · exit ${run.exitCode}`}</p>
          {run.failureReason && <p className="mt-2 text-sm text-[#9a3d31]">{run.failureReason}</p>}
          {run.parentRunId && <p className="mt-1 text-xs text-[#64717c]">Resolves finding from <Link className="underline" href={`/runs/${run.parentRunId}`}>{run.parentRunId}</Link></p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/workbench/${run.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-[#182a33] bg-white px-3 py-2 text-xs font-semibold text-[#182a33] hover:bg-[#f3f4f5]"><PanelsTopLeft className="size-3.5" />Open in workbench</Link>
          <button onClick={refreshAll} className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]"><RefreshCw className="size-3.5" />Refresh</button>
          {ACTIVE.includes(run.status) && <ActionButton variant="danger" confirm="Stop this run and tear down its sandbox?" onClick={async () => { await stopRun(run.id); await refreshAll(); }}>Stop run</ActionButton>}
          {run.status === "completed" && !d.review && (run.purpose ?? "builder") === "builder" && <ActionButton onClick={async () => { await createReview(run.id); await refreshAll(); }}>Start review</ActionButton>}
          {d.review && d.review.status === "needs_human" && <ActionButton disabled={openFindings.length > 0} onClick={async () => { await approveReview(d.review!.id, { actor: "human", reason: "Approved from dashboard" }); await refreshAll(); }}>Approve review{openFindings.length > 0 && ` (${openFindings.length} open)`}</ActionButton>}
          {d.review && d.review.status === "needs_human" && <ActionButton variant="danger" onClick={async () => { const reason = window.prompt("Why are you rejecting this run's changes?", ""); if (reason === null) return; await rejectReview(d.review!.id, { actor: "human", reason: reason || undefined }); await refreshAll(); }}>Reject review</ActionButton>}
          {d.review && <Link href={`/reviews/${d.review.id}`} className="rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]">Open review</Link>}
          <Link href={`/runs/${run.id}/manifest`} className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]"><FileText className="size-3.5" />Run manifest</Link>
          {d.review?.status === "approved" && !run.pullRequest && <ActionButton onClick={async () => { const branch = window.prompt("Branch name for the reviewed changes", `periscope/${run.id}`); if (branch === null) return; await createPullRequestFromRun(run.id, { branch }); await refreshAll(); }}><span className="inline-flex items-center gap-1.5"><GitPullRequestArrow className="size-3.5" />Create PR branch</span></ActionButton>}
        </div>
      </div>
      {run.pullRequest && <p className="mt-4 flex flex-wrap items-center gap-2 text-sm"><GitPullRequestArrow className="size-4 text-[#19734a]" /><span>Reviewed diff committed to branch <span className="mono">{run.pullRequest.branch}</span> ({run.pullRequest.commit.slice(0, 10)}) in <span className="mono">{run.repoPath}</span>{run.pullRequest.pushed ? ` · pushed to ${run.pullRequest.remote}` : " · not pushed"}</span>{run.pullRequest.compareUrl && <a className="underline" href={run.pullRequest.compareUrl} target="_blank" rel="noreferrer">Open pull request</a>}</p>}
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <AlignmentTile label="Request → Intent" segment={d.alignment.requestToIntent} />
        <AlignmentTile label="Intent → Behavior" segment={d.alignment.intentToBehavior} counts={d.alignment.counts} findings={d.findings} />
        <AlignmentTile label="Behavior → Result" segment={d.alignment.behaviorToResult} />
      </div>
    </header>

    <div className="flex gap-2 border-b">{(["chain", "findings", "timeline"] as const).map((item) => <button key={item} onClick={() => setTab(item)} className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold capitalize ${tab === item ? "border-[#182a33] text-[#182a33]" : "border-transparent text-[#64717c]"}`}>{item}{item === "findings" && ` (${findingGroups.length}${findingGroups.length !== d.findings.length ? ` · ${d.findings.length} signals` : ""})`}{item === "timeline" && timeline.data && ` (${timeline.data.length})`}</button>)}</div>

    {tab === "chain" && <div className="space-y-3">
      <RequestSection request={d.request} analysis={d.requestAnalysis} />
      <Arrow />
      <IntentSection intent={d.intent} onChanged={refreshAll} />
      <Arrow />
      <PermissionsSection permissions={d.permissions} />
      <Arrow />
      <BehaviorSection behavior={d.behaviorSummary} intent={d.intent} violations={violations} />
      <Arrow />
      <ResultSection result={d.result} detail={d} />
    </div>}

    {tab === "findings" && <div className="grid gap-3">
      {d.findings.length === 0 ? <Empty title="No findings" body="No policy, request/intent, intent/behavior or reviewer findings were recorded for this run." />
        : <><p className="text-xs text-[#64717c]">{findingGroups.length} affected file{findingGroups.length === 1 ? "" : "s"}/resource{findingGroups.length === 1 ? "" : "s"}, {d.findings.length} underlying signal{d.findings.length === 1 ? "" : "s"}. Grouped by what was affected; expand a row for evidence and actions.</p><FindingGroups findings={d.findings} resolutions={d.resolutions} onChanged={refreshAll} /></>}
    </div>}

    {tab === "timeline" && <Timeline entries={timeline.data ?? []} error={timeline.error} />}
  </div>;
}

function Back() { return <Link href="/runs" className="inline-flex items-center gap-2 text-sm text-[#64717c]"><ArrowLeft className="size-4" />Back to runs</Link>; }
function Arrow() { return <div className="flex justify-center text-[#98a4ad]"><ArrowDown className="size-5" /></div>; }

export function AlignmentTile({ label, segment, counts, findings }: { label: string; segment?: AlignmentSegment; counts?: RunDetailModel["alignment"]["counts"]; findings?: Finding[] }) {
  const deviations = counts ? counts.undeclaredFiles + counts.undeclaredDependencies + counts.undeclaredNetworkDestinations + counts.undeclaredTools : 0;
  const violations = counts?.constraintViolations ?? 0;
  const ids = new Set(segment?.findingIds ?? []);
  const affected = findings ? groupFindings(findings.filter((f) => ids.has(f.id))).length : segment?.findingIds.length ?? 0;
  return <div className={`rounded-xl border p-4 ${violations ? "border-[#c96b60] bg-[#fff1ee]" : "bg-[#f6f2ec]"}`}>
    <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">{label}</p><AlignmentBadge status={segment?.status} /></div>
    <p className="mt-2 text-sm text-[#3a4650]">{segment?.detail ?? "Not evaluated."}</p>
    {counts && <p className="mt-2 text-xs text-[#64717c]">{violations ? <span className="font-semibold text-[#8c2f26]">{violations} explicit rule{violations === 1 ? "" : "s"} broken · </span> : null}{deviations} undeclared · {counts.missingExpectedActions} missing expected</p>}
    {segment && segment.findingIds.length > 0 && <p className="mt-1 text-xs text-[#64717c]">{affected} affected resource{affected === 1 ? "" : "s"}{affected !== segment.findingIds.length && ` (${segment.findingIds.length} signals)`}</p>}
  </div>;
}

export function RequestSection({ request, analysis }: { request?: HumanRequest; analysis?: RequestAnalysis }) {
  return <Section eyebrow="1 · Human request" title={request ? "What the human asked for" : "No human request linked"}>
    {!request ? <p className="text-sm text-[#64717c]">This run was started without a first-class request. Alignment for Request → Intent cannot be evaluated.</p> : <div className="space-y-4">
      <blockquote className="whitespace-pre-wrap rounded-xl border-l-4 border-[#d1b191] bg-[#f6f2ec] p-4 text-sm">{request.rawPrompt}</blockquote>
      <p className="mono text-xs text-[#64717c]">{request.id} · {formatDateTime(request.createdAt)} · raw prompt is immutable</p>
      {analysis && <dl className="grid gap-3 md:grid-cols-2">
        <StatementList label="Objectives" items={analysis.objectives} />
        <StatementList label="Explicit constraints" items={analysis.explicitConstraints} />
        <StatementList label="Inferred expectations" items={analysis.inferredExpectations} />
        <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Forbidden resources</dt><dd className="mt-1.5">{analysis.explicitlyForbiddenResources.length ? <ul className="space-y-1 text-sm">{analysis.explicitlyForbiddenResources.map((r) => <li key={r.resource} className="flex flex-wrap items-center gap-2"><span className="mono">{r.resource}</span><span className="status status-muted">{r.category}</span><span className="text-xs text-[#64717c]">“{r.excerpt}”</span></li>)}</ul> : <span className="text-sm text-[#64717c]">none</span>}</dd></div>
        {analysis.ambiguities.length > 0 && <div className="md:col-span-2"><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Ambiguities</dt><dd className="mt-1.5 text-sm">{analysis.ambiguities.join("; ")}</dd></div>}
      </dl>}
    </div>}
  </Section>;
}

function StatementList({ label, items }: { label: string; items: RequestAnalysis["objectives"] }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">{label}</dt><dd className="mt-1.5">{items.length ? <ul className="space-y-1 text-sm">{items.map((s, i) => <li key={i} className="flex flex-wrap items-center gap-2"><span>{s.text}</span><span className={`status ${s.provenance === "explicit" ? "status-good" : "status-warn"}`}>{s.provenance}</span></li>)}</ul> : <span className="text-sm text-[#64717c]">none</span>}</dd></div>;
}

export function IntentSection({ intent, onChanged }: { intent?: AgentIntent; onChanged: () => Promise<void> }) {
  return <Section eyebrow="2 · Agent intent" title={intent ? intent.goal : "No declared intent"} action={intent && <div className="flex flex-col items-end gap-2"><AlignmentBadge status={intent.alignment?.status} />{intent.approval ? <span className={`status ${intent.approval.status === "approved" ? "status-good" : "status-bad"}`}>{intent.approval.status}{intent.approval.actor && ` by ${intent.approval.actor}`}</span> : <div className="flex gap-2"><ActionButton onClick={async () => { await approveIntent(intent.id, { actor: "human" }); await onChanged(); }}>Approve intent</ActionButton><ActionButton variant="danger" onClick={async () => { await rejectIntent(intent.id, { actor: "human", reason: "Rejected from dashboard" }); await onChanged(); }}>Reject</ActionButton></div>}</div>}>
    {!intent ? <p className="text-sm text-[#64717c]">The agent did not declare structured intent before execution, so Intent → Behavior drift cannot be evaluated.</p> : <dl className="space-y-3">
      <KeyValue label="Interpretation">{intent.interpretation || <span className="text-[#64717c]">—</span>}</KeyValue>
      <KeyValue label="Planned actions"><ol className="list-decimal space-y-1 pl-5">{intent.plannedChanges.map((a, i) => <li key={i}>{a}</li>)}</ol></KeyValue>
      <KeyValue label="Expected files"><Chips items={intent.expectedFiles} /></KeyValue>
      <KeyValue label="Expected commands"><Chips items={intent.expectedCommands} /></KeyValue>
      <KeyValue label="Expected dependencies"><Chips items={intent.expectedDependencies} /></KeyValue>
      <KeyValue label="Expected network"><Chips items={intent.expectedNetwork} /></KeyValue>
      <KeyValue label="Expected secrets"><Chips items={intent.expectedSecrets} /></KeyValue>
      <KeyValue label="Expected MCP / tools"><Chips items={[...intent.expectedMcpServers, ...intent.expectedTools]} /></KeyValue>
      <KeyValue label="Constraints"><Chips items={intent.constraints} mono={false} /></KeyValue>
      {intent.assumptions.length > 0 && <KeyValue label="Assumptions"><Chips items={intent.assumptions} mono={false} /></KeyValue>}
      <KeyValue label="Provenance"><span className="text-xs text-[#64717c]">Declared by {intent.createdBy.agentId} ({intent.createdBy.agentType}) at {formatDateTime(intent.createdAt)}{intent.planningRunId && <> in read-only planning run <Link className="underline" href={`/runs/${intent.planningRunId}`}>{intent.planningRunId}</Link></>}. Intent is agent-reported.</span></KeyValue>
    </dl>}
  </Section>;
}

export function PermissionsSection({ permissions }: { permissions?: PermissionSnapshot }) {
  return <Section eyebrow="3 · Permissions" title="What the agent was allowed to access">
    {!permissions ? <p className="text-sm text-[#64717c]">No permission snapshot recorded.</p> : <dl className="space-y-3">
      <KeyValue label="Filesystem"><Chips items={(permissions.filesystem ?? []).map((p) => `${p.path} · ${p.access === "read_write" ? "RW" : "R"}`)} /></KeyValue>
      <KeyValue label="Network"><Chips items={permissions.network ?? []} /></KeyValue>
      <KeyValue label="Secrets"><Chips items={permissions.secrets ?? []} /></KeyValue>
      <KeyValue label="MCP servers"><Chips items={(permissions.mcpServers ?? []).map((s) => typeof s === "string" ? s : s.name)} /></KeyValue>
      <KeyValue label="Tools"><Chips items={permissions.tools ?? []} /></KeyValue>
    </dl>}
  </Section>;
}

export function BehaviorSection({ behavior, intent, violations = new Set<string>() }: { behavior?: ObservedBehavior; intent?: AgentIntent; violations?: Set<string> }) {
  if (!behavior) return <Section eyebrow="4 · Observed behavior" title="No telemetry yet"><p className="text-sm text-[#64717c]">Behavior appears once the sandbox emits events.</p></Section>;
  const declared = (items: string[] | undefined) => new Set((items ?? []).map((i) => i.replace(/^\.\//, "")));
  const files = declared(intent?.expectedFiles);
  const deps = declared(intent?.expectedDependencies);
  const net = declared(intent?.expectedNetwork);
  const secretsUnavailable = !Array.isArray(behavior.secrets);
  const violated = (name: string) => violations.has(name) || violations.has(name.replace(/^\.\//, ""));
  const fileState = (i: ObservedItem): ItemState => violated(i.name) ? "violation" : intent && !matches(files, i.name) ? "undeclared" : "ok";
  return <Section eyebrow="4 · Observed behavior" title="What Periscope observed">
    <dl className="space-y-3">
      <KeyValue label="Files modified"><ObservedList items={behavior.files.modified} state={fileState} /></KeyValue>
      <KeyValue label="Files created"><ObservedList items={behavior.files.created} state={fileState} /></KeyValue>
      <KeyValue label="Files deleted"><ObservedList items={behavior.files.deleted} state={fileState} /></KeyValue>
      <KeyValue label="Files read"><UnavailableNote reason={behavior.files.read.reason} /></KeyValue>
      <KeyValue label="Commands"><ObservedList items={behavior.commands} state={(i) => i.exitCode == null ? "unknown" : i.exitCode === 0 ? "ok" : "failed"} suffix={(i) => i.exitCode != null ? `exit ${i.exitCode}` : "exit code not observed"} /></KeyValue>
      <KeyValue label="Tests"><ObservedList items={behavior.tests} state={(i) => i.passed === undefined ? "unknown" : i.passed ? "ok" : "failed"} suffix={(i) => i.passed === undefined ? "result unknown" : i.passed ? "passed" : "failed"} /></KeyValue>
      <KeyValue label="Dependencies added"><ObservedList items={behavior.dependenciesAdded} state={(i) => violated(i.name) ? "violation" : intent && !deps.has(i.name) ? "undeclared" : "ok"} /></KeyValue>
      <KeyValue label="Network destinations"><ObservedList items={behavior.networkDestinations} state={(i) => violated(i.name) || i.allowed === false ? "violation" : intent && !net.has(i.name) ? "undeclared" : "ok"} suffix={(i) => i.allowed === false ? "blocked by policy" : undefined} /></KeyValue>
      <KeyValue label="Secrets">{secretsUnavailable ? <UnavailableNote reason={(behavior.secrets as { reason: string }).reason} /> : <ObservedList items={behavior.secrets as ObservedItem[]} />}</KeyValue>
      <KeyValue label="MCP calls"><ObservedList items={behavior.mcpCalls} suffix={(i) => i.server} /></KeyValue>
      <KeyValue label="Tools"><ObservedList items={behavior.tools} /></KeyValue>
    </dl>
    <div className="mt-5 border-t pt-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Telemetry coverage</p>
      <p className="mt-1 text-xs text-[#64717c]">Channels marked unavailable cannot be observed; their absence above is not evidence that nothing happened.</p>
      <div className="mt-2 flex flex-wrap gap-2">{Object.entries(behavior.coverage).map(([channel, level]) => <span key={channel} className="inline-flex items-center gap-1.5 rounded-md border bg-white px-2 py-1 text-xs"><span className="mono">{channel}</span><VerificationBadge verification={level} /></span>)}</div>
    </div>
  </Section>;
}

function matches(declared: Set<string>, observed: string): boolean {
  const name = observed.replace(/^\.\//, "");
  for (const pattern of declared) {
    if (pattern === name) return true;
    if (pattern.endsWith("/**") && name.startsWith(pattern.slice(0, -3) + "/")) return true;
    if (pattern.endsWith("/*") && name.startsWith(pattern.slice(0, -2) + "/") && !name.slice(pattern.length - 1).includes("/")) return true;
  }
  return false;
}

type ItemState = "ok" | "undeclared" | "violation" | "failed" | "unknown";

const ITEM_GLYPH: Record<ItemState, { glyph: string; cls: string; badge?: { text: string; cls: string } }> = {
  ok: { glyph: "✓", cls: "text-[#14623f]" },
  undeclared: { glyph: "⚠", cls: "text-[#815017]", badge: { text: "undeclared", cls: "status-warn" } },
  violation: { glyph: "✕", cls: "text-[#8c2f26]", badge: { text: "violates human request", cls: "status-violation" } },
  failed: { glyph: "✕", cls: "text-[#8c2f26]", badge: { text: "failed", cls: "status-bad" } },
  unknown: { glyph: "?", cls: "text-[#98a4ad]" }
};

function ObservedList<T extends ObservedItem>({ items, state, suffix }: { items: T[]; state?: (item: T) => ItemState; suffix?: (item: T) => string | undefined }) {
  if (!items.length) return <span className="text-sm text-[#64717c]">none observed</span>;
  return <ul className="space-y-1">{items.map((item, index) => {
    const glyph = ITEM_GLYPH[state?.(item) ?? "ok"];
    const extra = suffix?.(item);
    return <li key={`${item.name}-${item.eventIds[0] ?? index}`} className="flex flex-wrap items-center gap-2 text-sm"><span className={glyph.cls} aria-hidden>{glyph.glyph}</span><span className="mono">{item.name}</span>{extra && <span className="text-xs text-[#64717c]">{extra}</span>}{glyph.badge && <span className={`status ${glyph.badge.cls}`}>{glyph.badge.text}</span>}<VerificationBadge verification={item.verification} /><span className="text-xs text-[#98a4ad]">{item.eventIds.length} event{item.eventIds.length === 1 ? "" : "s"}</span></li>;
  })}</ul>;
}

function UnavailableNote({ reason }: { reason: string }) {
  return <span className="inline-flex flex-wrap items-center gap-2 text-sm"><VerificationBadge verification="unavailable" /><span className="text-xs text-[#64717c]" title={verificationHelp("unavailable")}>{reason}</span></span>;
}

export function ResultSection({ result, detail }: { result: ResultSummary; detail: RunDetailModel }) {
  const approval = result.approvalStatus;
  return <Section eyebrow="5 · Result" title="What the agent produced" action={<span className={`status ${approval === "approved" ? "status-good" : approval === "needs_human" ? "status-warn" : approval === "rejected" ? "status-bad" : "status-muted"}`}>{approval.replace("_", " ")}</span>}>
    <dl className="space-y-3">
      <KeyValue label="Diff">{result.filesChanged.length} files · <span className="text-[#19734a]">+{result.insertions}</span> <span className="text-[#9a3d31]">−{result.deletions}</span>{result.commits.length > 0 && ` · ${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}`}</KeyValue>
      <KeyValue label="Files changed"><Chips items={result.filesChanged} /></KeyValue>
      <KeyValue label="Dependencies changed"><Chips items={result.dependenciesChanged.map((d) => `${d.type === "dependency_added" ? "+" : "−"} ${d.name} (${d.manifest})`)} /></KeyValue>
      <KeyValue label="Tests">{result.tests.length ? <ul className="space-y-1">{result.tests.map((t, i) => <li key={i} className="flex flex-wrap items-center gap-2 text-sm"><span className="mono">{t.command}</span><span className={`status ${t.passed ? "status-good" : t.passed === false ? "status-bad" : "status-muted"}`}>{t.passed === undefined ? "unknown" : t.passed ? "passed" : "failed"}</span><VerificationBadge verification={t.verification} /></li>)}</ul> : <span className="text-sm text-[#64717c]">no test execution observed</span>}</KeyValue>
      <KeyValue label="Review">{result.review ? <span>{result.review.filesReviewed} / {result.review.filesTotal} files reviewed · {result.review.filesWithFindings} with findings · <Link className="underline" href={`/reviews/${result.review.reviewId}`}>{result.review.status.replace("_", " ")}</Link>{result.review.approvedAt && ` · approved ${formatDateTime(result.review.approvedAt)}${result.review.approval?.actor ? ` by ${result.review.approval.actor}` : ""}`}{result.review.rejectedAt && ` · rejected ${formatDateTime(result.review.rejectedAt)}${result.review.rejection?.actor ? ` by ${result.review.rejection.actor}` : ""}${result.review.rejection?.reason ? ` — ${result.review.rejection.reason}` : ""}`}</span> : <span className="text-sm text-[#64717c]">not reviewed</span>}</KeyValue>
      <KeyValue label="Findings">{result.findings.total} total · {result.findings.open} open · {result.findings.resolved} resolved · {result.findings.dismissed} dismissed</KeyValue>
      {detail.resolutions.length > 0 && <KeyValue label="Resolutions"><ul className="space-y-1 text-sm">{detail.resolutions.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><span className={`status ${r.status === "resolved" ? "status-good" : r.status === "failed" ? "status-bad" : "status-info"}`}>{r.status.replace("_", " ")}</span><span className="mono text-xs">{r.findingId}</span>{r.resolutionRunId && <Link className="text-xs underline" href={`/runs/${r.resolutionRunId}`}>resolver run</Link>}{r.reReviewResult && <span className="text-xs text-[#64717c]">{r.reReviewResult.summary}</span>}</li>)}</ul></KeyValue>}
    </dl>
  </Section>;
}

/** Timeline actor labels; the protocol still emits `agentguard` for the Periscope observer. */
export const actorLabel: Record<TimelineEntry["actor"], string> = {
  human: "human",
  agent: "agent",
  agentguard: "periscope",
  runtime: "runtime",
  reviewer: "reviewer",
  resolver: "resolver"
};

export const actorStyle: Record<TimelineEntry["actor"], string> = {
  human: "bg-[#d1b191] text-[#182a33]",
  agent: "bg-[#eff8fc] text-[#265d78]",
  agentguard: "bg-[#182a33] text-[#ecdcc8]",
  runtime: "bg-[#f0f2f3] text-[#3a4650]",
  reviewer: "bg-[#fff8e8] text-[#815017]",
  resolver: "bg-[#effaf3] text-[#14623f]"
};

export function Timeline({ entries, error }: { entries: TimelineEntry[]; error: string | null }) {
  if (error) return <ErrorBanner message={error} />;
  if (!entries.length) return <Empty title="Timeline is empty" />;
  return <ol className="card divide-y">{entries.map((entry) => <li key={entry.id} className="grid gap-2 p-4 sm:grid-cols-[88px_110px_minmax(0,1fr)] sm:items-start">
    <span className="mono text-xs text-[#64717c]">{formatTime(entry.timestamp)}</span>
    <span className={`status justify-self-start border-transparent uppercase ${actorStyle[entry.actor]}`}>{actorLabel[entry.actor] ?? entry.actor}</span>
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{entry.title}</span><span className="mono text-[10px] text-[#98a4ad]">{entry.kind}</span>{entry.severity && entry.severity !== "info" && <SeverityBadge severity={entry.severity} />}<VerificationBadge verification={entry.verification} />{entry.evidenceSource && <span className="text-[10px] text-[#98a4ad]">via {entry.evidenceSource}</span>}</div>
      {entry.detail && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[#3a4650]">{entry.detail}</p>}
      <p className="mono mt-1 text-[10px] text-[#98a4ad]">{Object.entries(entry.refs).filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" · ")}</p>
    </div>
  </li>)}</ol>;
}
