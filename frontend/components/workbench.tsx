"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getEvents, getFiles, getRunDetail, stopRun, type RunTreeEntry } from "@/lib/api";
import { attemptsFor, commandsFor, reportedChangedFiles } from "@/lib/agent-actions";
import type { AgentEvent, PermissionSnapshot } from "@/lib/contracts";
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff";
import { subscribeToRunEvents } from "@/lib/event-stream";
import { useResource } from "@/lib/use-resource";
import { AmendmentsSection } from "./amendments";
import { PermissionsSection } from "./run-detail";
import { SessionExplorer } from "./session-explorer";
import { ActionButton, ErrorBanner, RunStatusBadge, VerificationBadge, formatTime } from "./ui";

const ACTIVE = ["pending", "starting", "running", "paused", "stopping"];
type FileMark = "declared" | "undeclared" | "expected_untouched";

export function Workbench({ runId }: { runId: string }) {
  const loadDetail = useCallback((signal: AbortSignal) => getRunDetail(runId, signal), [runId]);
  const loadFiles = useCallback((signal: AbortSignal) => getFiles(runId, signal), [runId]);
  const loadEvents = useCallback((signal: AbortSignal) => getEvents(runId, signal), [runId]);
  const detail = useResource(loadDetail, 5000);
  const files = useResource(loadFiles, 5000);
  const events = useResource(loadEvents, 8000);
  const [live, setLive] = useState<AgentEvent[]>([]);
  const [selected, setSelected] = useState<RunTreeEntry | null>(null);
  const [technical, setTechnical] = useState(false);
  const run = detail.data?.run;
  const agentName = run?.agentId.includes("claude") ? "Claude Code" : "Codex";
  const active = Boolean(run && ACTIVE.includes(run.status));
  useEffect(() => {
    setLive([]);
    setSelected(null);
  }, [runId]);
  useEffect(() => {
    if (active) return subscribeToRunEvents(runId, (event) => setLive((prev) => prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
  }, [runId, active]);
  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...(events.data ?? []), ...live].filter((e) => !seen.has(e.id) && !!seen.add(e.id)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [events.data, live]);
  const changed = useMemo(() => run?.workspaceMode === "local" ? reportedChangedFiles(all) : new Set(files.data?.files ?? []), [run?.workspaceMode, files.data, all]);
  const diffs = useMemo(() => parseUnifiedDiff(files.data?.diff ?? ""), [files.data?.diff]);
  const visible = all.filter((e) => technical || e.category === "agent" || (e.category === "filesystem" && run?.workspaceMode !== "local") || (e.allowed === false && !(run?.workspaceMode === "local" && e.category === "policy" && ["filesystem", "git"].includes(String(e.metadata?.sourceCategory)))) || (e.category === "runtime" && ["started", "completed", "failed", "stopped", "telemetry_degraded"].includes(e.action)));
  const recordedActions = all.some((e) => ["codex_session", "claude_hooks"].includes(String(e.metadata?.source)));
  const refresh = async () => { await Promise.all([detail.refresh(), files.refresh(), events.refresh()]); };
  if (detail.error && !detail.data) return <ErrorBanner message={detail.error} onRetry={detail.refresh} />;
  if (!run || !detail.data) return <p>Loading session…</p>;

  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><div className="flex items-center gap-3"><h1 className="text-xl font-semibold">Agent session</h1><RunStatusBadge status={run.status} /></div>
        <p className="mt-1 text-sm text-[#64717c]">{run.workspaceMode === "local" ? "Edits are applied to your local files immediately." : "Working in a separate workspace."}</p></div>
      <div className="flex items-center gap-3 text-sm">
        {run.projectId && <Link className="underline" href={`/projects/${run.projectId}`}>Project &amp; permissions</Link>}
        <Link className="text-[#64717c] underline" href={`/runs/${run.id}`}>Full run details</Link>
        {active && <ActionButton variant="danger" onClick={async () => { await stopRun(run.id); await refresh(); }}>Stop agent</ActionButton>}
      </div>
    </header>
    {detail.data.request && <details className="rounded-xl border bg-white p-3 text-sm"><summary className="cursor-pointer font-semibold">Task for this session</summary><p className="mt-2 whitespace-pre-wrap">{detail.data.request.rawPrompt}</p></details>}
    <AmendmentsSection runId={runId} onChanged={refresh} />
    <div className="grid min-h-[65vh] overflow-hidden rounded-xl border bg-white lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="border-b bg-[#faf8f5] lg:border-b-0 lg:border-r">
        <div className="border-b px-4 py-3"><h2 className="font-semibold">Project files</h2><p className="mt-1 text-xs text-[#64717c]">Badges show this agent’s access. ● means The agent reported a successful edit.</p></div>
        <div className="max-h-[65vh] overflow-auto"><SessionExplorer key={runId} runId={runId} changed={changed} selected={selected?.path ?? null} onSelect={setSelected} /></div>
        {changed.size > 0 && <details className="border-t p-3 text-xs"><summary className="cursor-pointer font-semibold">Agent-reported changes ({changed.size})</summary><ul className="mt-2 space-y-2">{[...changed].map((file) => <li key={file}><button className="break-all text-left underline" onClick={() => setSelected({ name: file, path: file, kind: "file", access: "read" })}>{file}</button></li>)}</ul><p className="mt-2 text-[#64717c]">Only explicit successful edit reports count. Shared-folder changes alone do not identify who made them.</p></details>}
      </aside>
      <main className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <button className={`font-semibold ${selected ? "text-[#64717c] underline" : ""}`} onClick={() => setSelected(null)}>Conversation &amp; actions</button>
          {!selected && <label className="flex items-center gap-2 text-xs text-[#64717c]"><input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />Show raw evidence</label>}
        </div>
        {selected ? <div>
          {run.workspaceMode === "local" && technical && <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900">Raw workspace diff: may include your edits or other processes. This is not an agent-only diff.</p>}
          <div className="border-b px-4 py-3"><h2 className="mono break-all text-sm font-semibold">{selected.path}</h2><p className="mt-1 text-xs text-[#64717c]">{changed.has(selected.path) ? "The agent reported an edit to this file." : "No successful agent edit reported for this file."} The explorer badges show agent access; select the folder to expand it.</p></div>
          {(run.workspaceMode !== "local" || technical) && diffs.some((d) => d.path === selected.path) ? <DiffView path={selected.path} diff={diffs.find((d) => d.path === selected.path)} /> : <p className="p-6 text-sm text-[#64717c]">{active ? "The agent’s tool requests below record attempted patches. A whole-folder diff can mix your edits with the agent’s, so it is not shown as an agent-only diff." : "No agent-only diff is available. Whole-folder diffs may contain edits from other local processes."}</p>}
        </div> : <div>
          <p className="border-b bg-[#faf8f5] px-4 py-3 text-xs text-[#64717c]">{recordedActions ? "Messages and tool requests are reported by the agent. File and network events are observed separately. Full tool output and private reasoning stay out of this feed." : "This session has not connected action logging. For the new conversation feed, exit and relaunch the agent with Periscope. Recorded file and network activity appears below."}</p>
          {events.error && <ErrorBanner message={events.error} onRetry={events.refresh} />}
          <div className="max-h-[65vh] overflow-auto"><Activity events={visible} all={all} permissions={detail.data.permissions ?? {}} agentName={agentName} /></div>
          <p className="border-t px-4 py-2 text-xs text-[#64717c]">{technical ? "Showing all recorded events." : `${all.length - visible.length} background events hidden, including routine model connections.`}</p>
        </div>}
      </main>
    </div>
    <details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">Session permissions</summary><div className="mt-4"><PermissionsSection permissions={detail.data.permissions ?? {}} /></div><p className="mt-3 text-xs text-[#64717c]">Project settings apply to the next launch. Stop and relaunch to change filesystem access. Hosted web search is separate from the network allowlist.</p></details>
  </div>;
}

function abbreviate(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 100 ? `${line.slice(0, 97)}…` : line || "Tool request";
}

function Activity({ events, all, permissions, agentName }: { events: AgentEvent[]; all: AgentEvent[]; permissions: PermissionSnapshot; agentName: string }) {
  if (!events.length) return <p className="p-6 text-sm text-[#64717c]">Waiting for messages or file activity…</p>;
  return <ol className="divide-y">{events.filter((e) => e.action !== "tool_result").map((event) => {
    const m = event.metadata ?? {};
    const result = m.callId ? all.find((e) => e.action === "tool_result" && e.metadata?.callId === m.callId) : undefined;
    const role = m.role;
    const commands = commandsFor(event);
    const attempts = attemptsFor(event, permissions);
    const outcome = result?.metadata?.outcome;
    const title = commands.length ? "Run command" : event.category === "agent" ? event.action === "message" ? role === "user" ? "You" : role === "notice" ? "Session" : agentName : String(m.tool ?? event.action).replaceAll("_", " ") : event.category === "filesystem" ? ({ create: "Created file", write: "Changed file", delete: "Deleted file" }[event.action] ?? event.action) : event.allowed === false ? event.category === "network" ? "Connection blocked" : "Policy finding" : `${event.category} · ${event.action}`;
    const args = m.arguments;
    const text = typeof m.text === "string" ? m.text : typeof m.message === "string" ? m.message : args !== undefined ? typeof args === "string" ? args : args && typeof args === "object" ? String((args as Record<string, unknown>).cmd ?? (args as Record<string, unknown>).command ?? (args as Record<string, unknown>).query ?? JSON.stringify(args, null, 2)) : String(args) : "";
    return <li key={event.id} className={`px-5 py-4 ${role === "user" ? "bg-[#f4f7fa]" : ""}`}>
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold capitalize">{title}</span>{event.action === "tool_call" && <span className={`rounded px-2 py-0.5 text-xs ${outcome === "denied" || outcome === "failed" ? "bg-red-50 text-red-800" : "bg-slate-100 text-slate-600"}`}>{outcome === "denied" ? "Denial reported" : outcome === "failed" ? "Failed" : outcome === "succeeded" ? "Success reported" : result ? "Result received · outcome unknown" : "Attempt recorded"}</span>}<span className="ml-auto text-xs text-[#98a4ad]">{formatTime(event.timestamp)}</span></div>
      {event.resource && <p className="mono mt-1 break-all text-xs">{event.resource}</p>}
      {commands.map((cmd, i) => {
        const targets = attemptsFor({ ...event, metadata: { arguments: { cmd: cmd.command, workdir: cmd.workdir } } }, permissions);
        const short = targets.length ? targets.slice(0, 2).map((target) => `${target.action} ${target.path.replace(/^\/workspace\//, "")}`).join(" · ") + (targets.length > 2 ? ` · +${targets.length - 2} more` : "") : abbreviate(cmd.command);
        return <details key={i} className="mt-2 overflow-hidden rounded-lg border">
          <summary className="cursor-pointer bg-[#f6f2ec] px-3 py-2 text-sm"><span className="font-medium">{short}</span>{cmd.escalation && <span className="ml-2 text-xs font-semibold text-amber-800">Elevation requested</span>}<span className="ml-2 text-xs text-[#64717c]">View command</span></summary>
          <p className="border-b px-3 py-2 text-xs text-[#64717c]">Working directory: {cmd.workdir}</p>
          <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5">{cmd.command}</pre>
        </details>;
      })}
      {attempts.some((attempt) => attempt.outside) && <p className="mt-2 text-xs text-amber-800">Outside the project inside the container; this alone does not establish host access or a sandbox escape.</p>}
      {!!attempts.length && <ul className="mt-3 space-y-1 text-xs">{attempts.map((attempt) => <li key={attempt.action + attempt.path} className="flex flex-wrap gap-2"><strong>{attempt.action} attempt</strong><span className="mono">{attempt.path}</span><span className={attempt.outside || attempt.access === "No access" || (attempt.action !== "Read" && attempt.action !== "Access" && attempt.access === "Read only") ? "text-amber-800" : "text-[#64717c]"}>{attempt.access}{attempt.action === "Read" && attempt.access === "Read only" ? " · reading permitted" : ""}</span></li>)}</ul>}
      {Array.isArray(result?.metadata?.reasons) && <p className="mt-2 text-xs text-red-800">{result.metadata.reasons.join(" · ")} (reported in tool result)</p>}
      {typeof result?.metadata?.exitCode === "number" && <p className="mt-1 text-xs text-[#64717c]">Exit code: {result.metadata.exitCode}</p>}
      {text && (event.action === "tool_call" ? <details className="mt-2 text-xs"><summary className="cursor-pointer text-[#64717c]">{commands.length ? "Raw tool request" : abbreviate(text)}{!commands.length && <span className="ml-2 text-[#64717c]">View details</span>}</summary><pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#f6f2ec] p-3">{text}</pre></details> : <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{text}</p>)}
      {event.category === "filesystem" && <p className="mt-1 text-[11px] text-[#64717c]">Observed on disk · may include edits from other processes</p>}
    </li>;
  })}</ol>;
}
function DiffView({ diff, path, mark }: { diff?: FileDiff; path: string; mark?: FileMark }) {
  if (!diff) return <div className="p-6 text-sm text-[#64717c]">No diff content available for <span className="mono">{path}</span>. File activity was observed; the final patch becomes available after the run ends if the file has a net change.</div>;
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
