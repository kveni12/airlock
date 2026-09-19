"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileCode2, LayoutList, MessageSquareText, RefreshCw, ShieldAlert, X } from "lucide-react";
import { approveReview, createReview, getEvents, getFiles, getRunDetail, getTimeline, stopRun } from "@/lib/api";
import type { AgentEvent, AlignmentStatus, TimelineEntry } from "@/lib/contracts";
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff";
import { subscribeToRunEvents } from "@/lib/event-stream";
import { useResource } from "@/lib/use-resource";
import { AccessExplorer, fileMarks, type FileMark } from "./access-explorer";
import { FindingCard } from "./finding-card";
import { AlignmentTile, BehaviorSection, IntentSection, PermissionsSection, RequestSection, ResultSection, Timeline, actorStyle } from "./run-detail";
import { ActionButton, AlignmentBadge, ErrorBanner, RunStatusBadge, Section, SeverityBadge, VerificationBadge, formatTime } from "./ui";

const ACTIVE = ["pending", "starting", "running", "stopping"];

export function Workbench({ runId }: { runId: string }) {
  const loadDetail = useCallback((signal: AbortSignal) => getRunDetail(runId, signal), [runId]);
  const loadFiles = useCallback((signal: AbortSignal) => getFiles(runId, signal), [runId]);
  const loadTimeline = useCallback((signal: AbortSignal) => getTimeline(runId, signal), [runId]);
  const loadEvents = useCallback((signal: AbortSignal) => getEvents(runId, signal), [runId]);
  const detail = useResource(loadDetail, 6000);
  const files = useResource(loadFiles, 8000);
  const timeline = useResource(loadTimeline, 6000);
  const events = useResource(loadEvents, 15000);
  const [live, setLive] = useState<AgentEvent[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [center, setCenter] = useState<"transcript" | "timeline">("transcript");
  const [rail, setRail] = useState<"chain" | "findings">("chain");

  const run = detail.data?.run;
  const active = run ? ACTIVE.includes(run.status) : false;

  useEffect(() => {
    if (!active) return;
    return subscribeToRunEvents(runId, (event) => setLive((prev) => prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
  }, [runId, active]);

  const allEvents = useMemo(() => {
    const seen = new Set<string>();
    return [...(events.data ?? []), ...live].filter((e) => seen.has(e.id) ? false : (seen.add(e.id), true)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [events.data, live]);

  const diffs = useMemo(() => parseUnifiedDiff(files.data?.diff ?? ""), [files.data?.diff]);
  const changedFiles = useMemo(() => files.data?.files ?? diffs.map((d) => d.path), [files.data?.files, diffs]);
  const marks = useMemo(() => fileMarks(changedFiles, detail.data?.intent), [changedFiles, detail.data?.intent]);
  const selectedDiff = selectedFile ? diffs.find((d) => d.path === selectedFile) : undefined;

  const refreshAll = async () => { await Promise.all([detail.refresh(), files.refresh(), timeline.refresh(), events.refresh()]); };

  if (detail.error && !detail.data) return <div className="space-y-4"><Back runId={runId} /><ErrorBanner message={detail.error} onRetry={detail.refresh} /></div>;
  if (!detail.data || !run) return <div className="space-y-4"><Back runId={runId} /><div className="skeleton h-12" /><div className="skeleton h-[70vh]" /></div>;
  const d = detail.data;
  const openFindings = d.findings.filter((f) => f.status === "open");

  return <div className="-m-4 flex h-[calc(100vh-4rem)] flex-col md:-m-7 lg:-m-9">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Back runId={runId} />
        <span className="mono truncate text-xs text-[#64717c]">{run.id}</span>
        <RunStatusBadge status={run.status} />
        <span className="status capitalize">{run.purpose ?? "builder"}</span>
        <span className="mono text-xs text-[#64717c]">{run.runtimeProvider}</span>
        {run.workspaceAccess === "read_only" && <span className="status status-muted">read-only</span>}
        {active && <span className="status status-info">live</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip label="Request → Intent" status={d.alignment.requestToIntent?.status} />
        <Chip label="Intent → Behavior" status={d.alignment.intentToBehavior?.status} />
        <Chip label="Behavior → Result" status={d.alignment.behaviorToResult?.status} />
        <button onClick={refreshAll} className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-semibold hover:bg-[#f3f4f5]"><RefreshCw className="size-3.5" />Refresh</button>
        {active && <ActionButton variant="danger" confirm="Stop this run and tear down its sandbox?" onClick={async () => { await stopRun(run.id); await refreshAll(); }}>Stop</ActionButton>}
        {run.status === "completed" && !d.review && (run.purpose ?? "builder") === "builder" && <ActionButton onClick={async () => { await createReview(run.id); await refreshAll(); }}>Start review</ActionButton>}
        {d.review?.status === "needs_human" && <ActionButton disabled={openFindings.length > 0} onClick={async () => { await approveReview(d.review!.id, { actor: "human", reason: "Approved from workbench" }); await refreshAll(); }}>Approve{openFindings.length > 0 && ` (${openFindings.length} open)`}</ActionButton>}
      </div>
    </div>

    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_400px]">
      <aside className="min-h-0 overflow-y-auto border-r bg-[#f6f2ec]">
        <AccessExplorer permissions={d.permissions} behavior={d.behaviorSummary} intent={d.intent} changedFiles={changedFiles} selected={selectedFile} onSelect={setSelectedFile}
          emptyFilesText={active ? "No git changes observed yet." : run.workspaceAccess === "read_only" ? "Read-only planning run: no writes expected." : "No file changes observed for this run."} />
      </aside>

      <section className="flex min-h-0 flex-col bg-white">
        <div className="flex items-center gap-1 border-b px-2">
          <TabButton active={!selectedFile && center === "transcript"} onClick={() => { setSelectedFile(null); setCenter("transcript"); }} icon={MessageSquareText}>Transcript ({allEvents.length})</TabButton>
          <TabButton active={!selectedFile && center === "timeline"} onClick={() => { setSelectedFile(null); setCenter("timeline"); }} icon={LayoutList}>Timeline ({timeline.data?.length ?? 0})</TabButton>
          {selectedFile && <TabButton active icon={FileCode2} onClick={() => undefined}><span className="mono">{selectedFile}</span><span onClick={(e) => { e.stopPropagation(); setSelectedFile(null); }} className="ml-1 rounded p-0.5 hover:bg-[#f0f2f3]"><X className="size-3" /></span></TabButton>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {selectedFile ? <DiffView diff={selectedDiff} path={selectedFile} mark={marks.get(selectedFile)} />
            : center === "timeline" ? <div className="p-3"><Timeline entries={timeline.data ?? []} error={timeline.error} /></div>
            : <Transcript events={allEvents} error={events.error} onFile={(p) => marks.has(p) && setSelectedFile(p)} />}
        </div>
      </section>

      <aside className="min-h-0 overflow-y-auto border-l bg-[#fbfbfa]">
        <div className="flex gap-1 border-b px-2">
          <TabButton active={rail === "chain"} onClick={() => setRail("chain")}>Chain</TabButton>
          <TabButton active={rail === "findings"} onClick={() => setRail("findings")}>Findings ({d.findings.length})</TabButton>
        </div>
        <div className="space-y-3 p-3">
          {rail === "chain" && <>
            <div className="grid gap-2">
              <AlignmentTile label="Request → Intent" segment={d.alignment.requestToIntent} />
              <AlignmentTile label="Intent → Behavior" segment={d.alignment.intentToBehavior} counts={d.alignment.counts} />
              <AlignmentTile label="Behavior → Result" segment={d.alignment.behaviorToResult} />
            </div>
            <RequestSection request={d.request} analysis={d.requestAnalysis} />
            <IntentSection intent={d.intent} onChanged={refreshAll} />
            <PermissionsSection permissions={d.permissions} />
            <OutOfScopeSection events={allEvents} onFile={(p) => marks.has(p) && setSelectedFile(p)} />
            <BehaviorSection behavior={d.behaviorSummary} intent={d.intent} />
            <ResultSection result={d.result} detail={d} />
          </>}
          {rail === "findings" && (d.findings.length === 0 ? <p className="text-sm text-[#64717c]">No findings for this run.</p>
            : d.findings.map((finding) => <FindingCard key={finding.id} finding={finding} resolutions={d.resolutions.filter((r) => r.findingId === finding.id)} onChanged={refreshAll} />))}
        </div>
      </aside>
    </div>
  </div>;
}

function Back({ runId }: { runId: string }) {
  return <Link href={`/runs/${runId}`} className="inline-flex items-center gap-1.5 text-xs text-[#64717c] hover:text-[#182a33]"><ArrowLeft className="size-3.5" />Run detail</Link>;
}

function Chip({ label, status }: { label: string; status: AlignmentStatus | undefined }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-[#64717c]">{label}<AlignmentBadge status={status} /></span>;
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon?: typeof FileCode2; children: React.ReactNode }) {
  return <button onClick={onClick} className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold ${active ? "border-[#182a33] text-[#182a33]" : "border-transparent text-[#64717c] hover:text-[#182a33]"}`}>{Icon && <Icon className="size-3.5" />}{children}</button>;
}

function DiffView({ diff, path, mark }: { diff?: FileDiff; path: string; mark?: FileMark }) {
  if (!diff) return <div className="p-6 text-sm text-[#64717c]">No diff content available for <span className="mono">{path}</span>. The change was observed via git, but the run did not retain a patch for it.</div>;
  return <div>
    <div className="flex flex-wrap items-center gap-2 border-b bg-[#f6f2ec] px-4 py-2 text-xs">
      <span className="status capitalize">{diff.status}</span>
      <span className="text-[#19734a]">+{diff.additions}</span><span className="text-[#9a3d31]">−{diff.deletions}</span>
      {mark === "undeclared" && <span className="status status-warn">not declared in intent</span>}
      <VerificationBadge verification="independent" /><span className="text-[#98a4ad]">via git</span>
    </div>
    {diff.binary ? <p className="p-6 text-sm text-[#64717c]">Binary file.</p> : <table className="mono w-full border-collapse text-[12px] leading-5"><tbody>
      {diff.lines.map((line, i) => line.kind === "hunk"
        ? <tr key={i} className="bg-[#eff8fc] text-[#265d78]"><td colSpan={3} className="px-3 py-0.5">{line.text}</td></tr>
        : <tr key={i} className={line.kind === "add" ? "bg-[#effaf3]" : line.kind === "del" ? "bg-[#fdf1ef]" : ""}>
          <td className="w-10 select-none border-r px-2 text-right text-[#98a4ad]">{line.oldNumber ?? ""}</td>
          <td className="w-10 select-none border-r px-2 text-right text-[#98a4ad]">{line.newNumber ?? ""}</td>
          <td className="whitespace-pre-wrap break-all px-3"><span className={`mr-2 select-none ${line.kind === "add" ? "text-[#19734a]" : line.kind === "del" ? "text-[#9a3d31]" : "text-[#c3cbd0]"}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>{line.text}</td>
        </tr>)}
    </tbody></table>}
  </div>;
}

const categoryActor: Record<string, TimelineEntry["actor"]> = { agent: "agent", mcp: "agent", runtime: "runtime", process: "runtime", filesystem: "runtime", network: "runtime", git: "runtime", secret: "runtime", policy: "agentguard", review: "reviewer", resolution: "resolver" };

function Transcript({ events, error, onFile }: { events: AgentEvent[]; error: string | null; onFile: (path: string) => void }) {
  if (error && events.length === 0) return <div className="p-3"><ErrorBanner message={error} /></div>;
  if (!events.length) return <p className="p-6 text-sm text-[#64717c]">No events yet. The transcript fills in as the sandbox emits telemetry.</p>;
  return <ol className="divide-y">{events.map((e) => {
    const actor = categoryActor[e.category] ?? "runtime";
    const text = describe(e);
    const file = typeof e.resource === "string" && (e.category === "filesystem" || e.category === "git") ? e.resource.replace(/^\/workspace\//, "") : null;
    return <li key={e.id} className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[64px_84px_minmax(0,1fr)]">
      <span className="mono text-[11px] text-[#64717c]">{formatTime(e.timestamp)}</span>
      <span className={`status justify-self-start border-transparent uppercase ${actorStyle[actor]}`}>{e.category}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="mono font-semibold">{e.action}</span>{file && <button onClick={() => onFile(file)} className="mono underline decoration-dotted">{file}</button>}{!file && e.resource && <span className="mono text-[#3a4650]">{e.resource}</span>}{e.severity && e.severity !== "info" && <SeverityBadge severity={e.severity} />}{e.allowed === false && <span className="status status-bad">blocked</span>}<VerificationBadge verification={e.verification} /></div>
        {text && <pre className={`mt-1 whitespace-pre-wrap break-words text-[12px] ${e.action === "message" ? "text-[#182a33]" : "text-[#3a4650]"}`}>{text}</pre>}
      </div>
    </li>;
  })}</ol>;
}

function describe(e: AgentEvent): string | null {
  const m = e.metadata ?? {};
  if (typeof m.text === "string") return m.text;
  if (typeof m.message === "string") return m.message;
  if (Array.isArray(m.command)) return m.command.map(String).join(" ");
  if (typeof m.command === "string") return `$ ${m.command}${m.exitCode !== undefined ? `  → exit ${m.exitCode}` : ""}`;
  if (typeof m.exitCode === "number") return `exit ${m.exitCode}`;
  if (typeof m.host === "string") return `${m.method ?? ""} ${m.host}${m.path ?? ""}`.trim();
  if (typeof m.tool === "string") return `${m.server ? `${m.server} · ` : ""}${m.tool}`;
  if (m.intent && typeof m.intent === "object") return JSON.stringify(m.intent, null, 2);
  return null;
}

interface OutOfScopeItem {
  key: string;
  what: string;
  resource?: string;
  outcome: "blocked" | "flagged";
  event: AgentEvent;
}

/** Attempts outside the declared access scope: blocked network destinations and policy violations. Derived from events only — never from absence. */
function outOfScopeItems(events: AgentEvent[]): OutOfScopeItem[] {
  const items: OutOfScopeItem[] = [];
  const violated = new Set<string>();
  for (const e of events) {
    if (e.category !== "policy" || e.action !== "violation") continue;
    const m = e.metadata ?? {};
    const rule = typeof m.rule === "string" ? m.rule : "";
    const source = typeof m.sourceEventId === "string" ? m.sourceEventId : "";
    if (rule === "permission_scope") { violated.add(source); items.push({ key: e.id, what: "Changed a file outside the allowed folders", resource: e.resource, outcome: "flagged", event: e }); }
    else if (rule === "network_scope") { violated.add(source); items.push({ key: e.id, what: "Tried to reach a host not on the internet allowlist", resource: e.resource, outcome: "blocked", event: e }); }
  }
  for (const e of events) {
    if (e.category === "network" && e.allowed === false && !violated.has(e.id)) items.push({ key: e.id, what: "Tried to reach a host not on the internet allowlist", resource: e.resource, outcome: "blocked", event: e });
  }
  return items.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));
}

function OutOfScopeSection({ events, onFile }: { events: AgentEvent[]; onFile: (path: string) => void }) {
  const items = useMemo(() => outOfScopeItems(events), [events]);
  return <Section eyebrow="3b · Out of scope" title="Asked for more than allowed" action={items.length ? <span className="status status-warn"><ShieldAlert className="mr-1 size-3.5" />{items.length}</span> : <span className="status status-good">none observed</span>}>
    {items.length === 0 ? <p className="text-sm text-[#64717c]">No blocked network requests or out-of-scope file changes were observed. Reads inside the workspace and direct (non-proxy) sockets cannot be observed, so this is not proof of absence.</p>
      : <ul className="space-y-2">{items.map((item) => {
        const path = item.resource?.replace(/^\/workspace\//, "");
        return <li key={item.key} className="rounded-lg border bg-white px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`status ${item.outcome === "blocked" ? "status-bad" : "status-warn"}`}>{item.outcome === "blocked" ? "blocked" : "happened · flagged"}</span>
            <span>{item.what}</span>
            <VerificationBadge verification={item.event.verification} />
            <span className="mono text-xs text-[#98a4ad]">{formatTime(item.event.timestamp)}</span>
          </div>
          {item.resource && <p className="mono mt-1 text-xs">{item.outcome === "flagged" && path ? <button onClick={() => onFile(path)} className="underline decoration-dotted">{path}</button> : item.resource}</p>}
        </li>;
      })}</ul>}
  </Section>;
}
