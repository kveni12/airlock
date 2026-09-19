"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowRight, FileCode2, Network, Search, ShieldAlert, TerminalSquare } from "lucide-react";
import { subscribeToRunEvents } from "../lib/event-stream";
import type { AgentEvent, EventCategory } from "../lib/contracts";
import { isRunActive, statusLabel } from "../lib/mappers.js";
import { useAgentGuardSnapshot } from "../lib/use-snapshot";
import { ConnectionError, LoadingState } from "./backend-state";
import { FilterChips } from "./ui";

const categoryLabel = (item: string) => (item === "mcp" ? "MCP" : item);

const filters: Array<"all" | EventCategory> = ["all", "agent", "filesystem", "process", "network", "secret", "mcp", "git", "policy", "runtime"];

const demoEvents: AgentEvent[] = [
  { id: "demo-1", runId: "demo", taskId: "task-241", agentId: "code-reviewer", timestamp: new Date().toISOString(), category: "policy", action: "violation", resource: ".env", allowed: false, severity: "high" },
  { id: "demo-2", runId: "demo", taskId: "task-241", agentId: "code-reviewer", timestamp: new Date(Date.now() - 92000).toISOString(), category: "filesystem", action: "write", resource: "src/auth/oauth.ts", allowed: true, severity: "info" },
  { id: "demo-3", runId: "demo", taskId: "task-240", agentId: "test-runner", timestamp: new Date(Date.now() - 220000).toISOString(), category: "process", action: "command_result", resource: "npm test", allowed: true, severity: "info" }
];

function EventIcon({ category }: { category: EventCategory }) {
  if (category === "filesystem" || category === "git") return <FileCode2 className="size-4" />;
  if (category === "network") return <Network className="size-4" />;
  if (category === "policy" || category === "secret") return <ShieldAlert className="size-4" />;
  if (category === "process" || category === "mcp") return <TerminalSquare className="size-4" />;
  return <Activity className="size-4" />;
}

export function ActivityFeed({ initialFilter = "all" }: { initialFilter?: (typeof filters)[number] }) {
  const { snapshot, loading, error, refresh } = useAgentGuardSnapshot();
  const [filter, setFilter] = useState<(typeof filters)[number]>(initialFilter);
  const [query, setQuery] = useState("");
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    if (!snapshot) return;
    const activeIds = snapshot.runs.filter((run) => isRunActive(run.status)).map((run) => run.id);
    const unsubscribe = activeIds.map((runId) => subscribeToRunEvents(runId, (event) => {
      setLiveEvents((current) => [event, ...current.filter((item) => item.id !== event.id)].slice(0, 250));
    }));
    return () => unsubscribe.forEach((stop) => stop());
  }, [snapshot]);

  const events = useMemo(() => {
    const recorded = snapshot ? Object.values(snapshot.eventsByRun).flat() : [];
    const merged = [...liveEvents, ...recorded].filter((event, index, list) => list.findIndex((item) => item.id === event.id) === index);
    const source = merged.length ? merged : demoEvents;
    const q = query.trim().toLowerCase();
    return source.filter((event) => (filter === "all" || event.category === filter)
      && (!q || `${event.category}.${event.action} ${event.resource ?? ""} ${event.runId} ${event.taskId} ${event.agentId}`.toLowerCase().includes(q))).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [filter, query, liveEvents, snapshot]);
  const runTask = useMemo(() => new Map((snapshot?.runs ?? []).map((run) => [run.id, run.taskId])), [snapshot]);

  if (loading && !snapshot) return <LoadingState />;

  return <section>
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="eyebrow">Runtime evidence</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Activity</h1><p className="mt-2 max-w-2xl text-sm text-[#64717c]">Recorded backend events plus live server-sent events for active runs.</p></div>
      <button onClick={refresh} className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold hover:bg-[#f3f4f5]">Refresh</button>
    </div>
    {error && <div className="mb-5"><ConnectionError message={error} onRetry={refresh} /></div>}
    <div className="mb-5 flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-[#76838d]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search action, resource, run or task id" className="w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[#19734a]" /></label>
      <FilterChips items={filters} value={filter} onChange={setFilter} label={(item) => (item === "all" ? "All" : item === "mcp" ? "MCP" : item[0].toUpperCase() + item.slice(1))} />
    </div>
    <div className="card overflow-hidden">
      {events.length === 0 ? <p className="p-8 text-center text-sm text-[#64717c]">No events match this filter{query ? " or search" : ""}.</p> : events.map((event) => {
        const isRun = event.runId !== "demo" && runTask.has(event.runId);
        return <article key={event.id} className="grid gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[36px_minmax(0,1fr)_auto] sm:items-center">
          <span className={`grid size-9 place-items-center rounded-lg ${event.category === "policy" || event.allowed === false ? "bg-[#fff2df] text-[#8c5112]" : "bg-[#eceff1] text-[#276142]"}`}><EventIcon category={event.category} /></span>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{statusLabel(event.action)}</span><span className="status">{categoryLabel(event.category)}</span>{event.allowed === false && <span className="status status-warn">Blocked</span>}{event.category === "policy" && <span className="status status-bad">Policy</span>}</div><p className="mono mt-1 truncate text-xs text-[#64717c]">{event.resource ?? "—"}</p><p className="mt-1 truncate text-xs text-[#64717c]">{isRun ? <Link href={`/runs/${event.runId}`} className="inline-flex items-center gap-1 font-semibold text-[#19734a] hover:underline">{runTask.get(event.runId)} <ArrowRight className="size-3" /></Link> : event.taskId}</p></div>
          <div className="text-left sm:text-right"><p className="text-xs text-[#64717c]">{new Date(event.timestamp).toLocaleString()}</p><p className="mt-1 text-xs font-semibold capitalize text-[#2c553e]">{statusLabel(event.severity ?? "info")}</p></div>
        </article>;
      })}
    </div>
    {!snapshot && <p className="mt-3 text-xs text-[#64717c]">Showing sample events while the runtime backend is unavailable.</p>}
  </section>;
}



