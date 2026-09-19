"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FolderOpen, LayoutList, MessageSquareText, RefreshCw, X } from "lucide-react";
import { approveReview, createReview, getEvents, getFiles, getRunDetail, getTimeline, stopRun } from "@/lib/api";
import type { AgentEvent, AgentIntent, AlignmentStatus, TimelineEntry } from "@/lib/contracts";
import { buildTree, parseUnifiedDiff, type FileDiff, type TreeNode } from "@/lib/diff";
import { subscribeToRunEvents } from "@/lib/event-stream";
import { useResource } from "@/lib/use-resource";
import { FindingCard } from "./finding-card";
import { AlignmentTile, BehaviorSection, IntentSection, PermissionsSection, RequestSection, ResultSection, Timeline, actorStyle } from "./run-detail";
import { ActionButton, AlignmentBadge, ErrorBanner, RunStatusBadge, SeverityBadge, VerificationBadge, formatTime } from "./ui";

const ACTIVE = ["pending", "starting", "running", "stopping"];

type FileMark = "declared" | "undeclared" | "expected_untouched";

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
  const marks = useMemo(() => fileMarks(files.data?.files ?? diffs.map((d) => d.path), detail.data?.intent), [files.data?.files, diffs, detail.data?.intent]);
  const tree = useMemo(() => buildTree([...marks.keys()]), [marks]);
  const selectedDiff = selectedFile ? diffs.find((d) => d.path === selectedFile) : undefined;

  const refreshAll = async () => { await Promise.all([detail.refresh(), files.refresh(), timeline.refresh(), events.refresh()]); };

  if (detail.error && !detail.data) return <div className="space-y-4"><Back runId={runId} /><ErrorBanner message={detail.error} onRetry={detail.refresh} /></div>;
  if (!detail.data || !run) return <div className="space-y-4"><Back runId={runId} /><div className="skeleton h-12" /><div className="skeleton h-[70vh]" /></div>;
  const d = detail.data;
  const openFindings = d.findings.filter((f) => f.status === "open");
  const undeclaredCount = [...marks.values()].filter((m) => m === "undeclared").length;

  return <div className="-m-4 flex h-[calc(100vh-4rem)] flex-col md:-m-7 lg:-m-9">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Back runId={runId} />
        <span className="mono truncate text-xs text-[#657068]">{run.id}</span>
        <RunStatusBadge status={run.status} />
        <span className="status capitalize">{run.purpose ?? "builder"}</span>
        <span className="mono text-xs text-[#657068]">{run.runtimeProvider}</span>
        {run.workspaceAccess === "read_only" && <span className="status status-muted">read-only</span>}
        {active && <span className="status status-info">live</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip label="Request → Intent" status={d.alignment.requestToIntent?.status} />
        <Chip label="Intent → Behavior" status={d.alignment.intentToBehavior?.status} />
        <Chip label="Behavior → Result" status={d.alignment.behaviorToResult?.status} />
        <button onClick={refreshAll} className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-semibold hover:bg-[#f4f7f1]"><RefreshCw className="size-3.5" />Refresh</button>
        {active && <ActionButton variant="danger" confirm="Stop this run and tear down its sandbox?" onClick={async () => { await stopRun(run.id); await refreshAll(); }}>Stop</ActionButton>}
        {run.status === "completed" && !d.review && (run.purpose ?? "builder") === "builder" && <ActionButton onClick={async () => { await createReview(run.id); await refreshAll(); }}>Start review</ActionButton>}
        {d.review?.status === "needs_human" && <ActionButton disabled={openFindings.length > 0} onClick={async () => { await approveReview(d.review!.id, { actor: "human", reason: "Approved from workbench" }); await refreshAll(); }}>Approve{openFindings.length > 0 && ` (${openFindings.length} open)`}</ActionButton>}
      </div>
    </div>

    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_400px]">
      <aside className="min-h-0 overflow-y-auto border-r bg-[#f7f9f4]">
        <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[#657068]"><span className="inline-flex items-center gap-1.5"><FolderOpen className="size-3.5" />Changed files</span><span>{marks.size}{undeclaredCount > 0 && <span className="ml-1 text-[#815017]">· {undeclaredCount} undeclared</span>}</span></div>
        {marks.size === 0 ? <p className="px-3 pb-3 text-xs text-[#657068]">{active ? "No git changes observed yet." : run.workspaceAccess === "read_only" ? "Read-only planning run: no writes expected." : "No file changes observed for this run."}</p>
          : <Tree nodes={tree} marks={marks} selected={selectedFile} onSelect={setSelectedFile} />}
        <div className="mt-2 border-t px-3 py-3 text-[11px] text-[#657068]">
          <p><span className="text-[#14623f]">●</span> changed, declared in intent</p>
          <p><span className="text-[#815017]">●</span> changed, not declared</p>
          <p><span className="text-[#9ca99d]">○</span> declared, no change observed</p>
          <p className="mt-2">Changes are independently observed via git; the full tree of the workspace is not retained after the sandbox is torn down.</p>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col bg-white">
        <div className="flex items-center gap-1 border-b px-2">
          <TabButton active={!selectedFile && center === "transcript"} onClick={() => { setSelectedFile(null); setCenter("transcript"); }} icon={MessageSquareText}>Transcript ({allEvents.length})</TabButton>
          <TabButton active={!selectedFile && center === "timeline"} onClick={() => { setSelectedFile(null); setCenter("timeline"); }} icon={LayoutList}>Timeline ({timeline.data?.length ?? 0})</TabButton>
          {selectedFile && <TabButton active icon={FileCode2} onClick={() => undefined}><span className="mono">{selectedFile}</span><span onClick={(e) => { e.stopPropagation(); setSelectedFile(null); }} className="ml-1 rounded p-0.5 hover:bg-[#f1f4ee]"><X className="size-3" /></span></TabButton>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {selectedFile ? <DiffView diff={selectedDiff} path={selectedFile} mark={marks.get(selectedFile)} />
            : center === "timeline" ? <div className="p-3"><Timeline entries={timeline.data ?? []} error={timeline.error} /></div>
            : <Transcript events={allEvents} error={events.error} onFile={(p) => marks.has(p) && setSelectedFile(p)} />}
        </div>
      </section>

      <aside className="min-h-0 overflow-y-auto border-l bg-[#fbfcf8]">
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
            <BehaviorSection behavior={d.behaviorSummary} intent={d.intent} />
            <ResultSection result={d.result} detail={d} />
          </>}
          {rail === "findings" && (d.findings.length === 0 ? <p className="text-sm text-[#657068]">No findings for this run.</p>
            : d.findings.map((finding) => <FindingCard key={finding.id} finding={finding} resolutions={d.resolutions.filter((r) => r.findingId === finding.id)} onChanged={refreshAll} />))}
        </div>
      </aside>
    </div>
  </div>;
}

function fileMarks(changed: string[], intent?: AgentIntent): Map<string, FileMark> {
  const declared = (intent?.expectedFiles ?? []).map((f) => f.replace(/^\.\//, ""));
  const matches = (name: string) => declared.some((p) => p === name || (p.endsWith("/**") && name.startsWith(p.slice(0, -3) + "/")) || (p.endsWith("/*") && name.startsWith(p.slice(0, -2) + "/") && !name.slice(p.length - 1).includes("/")));
  const marks = new Map<string, FileMark>();
  for (const file of changed) marks.set(file, intent ? (matches(file) ? "declared" : "undeclared") : "declared");
  for (const file of declared) if (!file.includes("*") && !marks.has(file)) marks.set(file, "expected_untouched");
  return marks;
}

function Back({ runId }: { runId: string }) {
  return <Link href={`/runs/${runId}`} className="inline-flex items-center gap-1.5 text-xs text-[#657068] hover:text-[#101913]"><ArrowLeft className="size-3.5" />Run detail</Link>;
}

function Chip({ label, status }: { label: string; status: AlignmentStatus | undefined }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-[#657068]">{label}<AlignmentBadge status={status} /></span>;
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon?: typeof FileCode2; children: React.ReactNode }) {
  return <button onClick={onClick} className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold ${active ? "border-[#101913] text-[#101913]" : "border-transparent text-[#657068] hover:text-[#101913]"}`}>{Icon && <Icon className="size-3.5" />}{children}</button>;
}

const markDot: Record<FileMark, string> = { declared: "text-[#14623f]", undeclared: "text-[#815017]", expected_untouched: "text-[#9ca99d]" };

function Tree({ nodes, marks, selected, onSelect, depth = 0 }: { nodes: TreeNode[]; marks: Map<string, FileMark>; selected: string | null; onSelect: (path: string) => void; depth?: number }) {
  return <ul>{nodes.map((node) => <TreeRow key={node.path} node={node} marks={marks} selected={selected} onSelect={onSelect} depth={depth} />)}</ul>;
}

function TreeRow({ node, marks, selected, onSelect, depth }: { node: TreeNode; marks: Map<string, FileMark>; selected: string | null; onSelect: (path: string) => void; depth: number }) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${8 + depth * 14}px` };
  if (!node.file) {
    return <li>
      <button onClick={() => setOpen(!open)} style={pad} className="flex w-full items-center gap-1 py-1 pr-2 text-left text-xs text-[#3a443c] hover:bg-[#eef2e9]">{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<span className="mono">{node.name}/</span></button>
      {open && <Tree nodes={node.children} marks={marks} selected={selected} onSelect={onSelect} depth={depth + 1} />}
    </li>;
  }
  const mark = marks.get(node.path) ?? "declared";
  const untouched = mark === "expected_untouched";
  return <li>
    <button onClick={() => onSelect(node.path)} style={pad} disabled={untouched} title={untouched ? "Declared in intent but no change observed" : mark} className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs ${selected === node.path ? "bg-[#dff869] text-[#17200f]" : untouched ? "text-[#9ca99d]" : "text-[#101913] hover:bg-[#eef2e9]"}`}>
      <span className={markDot[mark]}>{untouched ? "○" : "●"}</span><span className="mono truncate">{node.name}</span>
      {mark === "undeclared" && <span className="ml-auto status status-warn !px-1 !py-0 !text-[9px]">undeclared</span>}
    </button>
  </li>;
}

function DiffView({ diff, path, mark }: { diff?: FileDiff; path: string; mark?: FileMark }) {
  if (!diff) return <div className="p-6 text-sm text-[#657068]">No diff content available for <span className="mono">{path}</span>. The change was observed via git, but the run did not retain a patch for it.</div>;
  return <div>
    <div className="flex flex-wrap items-center gap-2 border-b bg-[#f7f9f4] px-4 py-2 text-xs">
      <span className="status capitalize">{diff.status}</span>
      <span className="text-[#19734a]">+{diff.additions}</span><span className="text-[#9a3d31]">−{diff.deletions}</span>
      {mark === "undeclared" && <span className="status status-warn">not declared in intent</span>}
      <VerificationBadge verification="independent" /><span className="text-[#9ca99d]">via git</span>
    </div>
    {diff.binary ? <p className="p-6 text-sm text-[#657068]">Binary file.</p> : <table className="mono w-full border-collapse text-[12px] leading-5"><tbody>
      {diff.lines.map((line, i) => line.kind === "hunk"
        ? <tr key={i} className="bg-[#eff8fc] text-[#265d78]"><td colSpan={3} className="px-3 py-0.5">{line.text}</td></tr>
        : <tr key={i} className={line.kind === "add" ? "bg-[#effaf3]" : line.kind === "del" ? "bg-[#fdf1ef]" : ""}>
          <td className="w-10 select-none border-r px-2 text-right text-[#9ca99d]">{line.oldNumber ?? ""}</td>
          <td className="w-10 select-none border-r px-2 text-right text-[#9ca99d]">{line.newNumber ?? ""}</td>
          <td className="whitespace-pre-wrap break-all px-3"><span className={`mr-2 select-none ${line.kind === "add" ? "text-[#19734a]" : line.kind === "del" ? "text-[#9a3d31]" : "text-[#c5ccc2]"}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>{line.text}</td>
        </tr>)}
    </tbody></table>}
  </div>;
}

const categoryActor: Record<string, TimelineEntry["actor"]> = { agent: "agent", mcp: "agent", runtime: "runtime", process: "runtime", filesystem: "runtime", network: "runtime", git: "runtime", secret: "runtime", policy: "agentguard", review: "reviewer", resolution: "resolver" };

function Transcript({ events, error, onFile }: { events: AgentEvent[]; error: string | null; onFile: (path: string) => void }) {
  if (error && events.length === 0) return <div className="p-3"><ErrorBanner message={error} /></div>;
  if (!events.length) return <p className="p-6 text-sm text-[#657068]">No events yet. The transcript fills in as the sandbox emits telemetry.</p>;
  return <ol className="divide-y">{events.map((e) => {
    const actor = categoryActor[e.category] ?? "runtime";
    const text = describe(e);
    const file = typeof e.resource === "string" && (e.category === "filesystem" || e.category === "git") ? e.resource.replace(/^\/workspace\//, "") : null;
    return <li key={e.id} className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[64px_84px_minmax(0,1fr)]">
      <span className="mono text-[11px] text-[#657068]">{formatTime(e.timestamp)}</span>
      <span className={`status justify-self-start border-transparent uppercase ${actorStyle[actor]}`}>{e.category}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="mono font-semibold">{e.action}</span>{file && <button onClick={() => onFile(file)} className="mono underline decoration-dotted">{file}</button>}{!file && e.resource && <span className="mono text-[#3a443c]">{e.resource}</span>}{e.severity && e.severity !== "info" && <SeverityBadge severity={e.severity} />}{e.allowed === false && <span className="status status-bad">blocked</span>}<VerificationBadge verification={e.verification} /></div>
        {text && <pre className={`mt-1 whitespace-pre-wrap break-words text-[12px] ${e.action === "message" ? "text-[#101913]" : "text-[#3a443c]"}`}>{text}</pre>}
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
