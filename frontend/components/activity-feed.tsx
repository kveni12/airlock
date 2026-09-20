"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, FileCode2, Network, ShieldAlert, TerminalSquare } from "lucide-react";
import { subscribeToRunEvents } from "../lib/event-stream";
import type { AgentEvent, EventCategory } from "../lib/contracts";
import { isRunActive, statusLabel } from "../lib/mappers.js";
import { useAgentGuardSnapshot } from "../lib/use-snapshot";
import { ConnectionError, LoadingState } from "./backend-state";

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

export function ActivityFeed() {
  const { snapshot, loading, error, refresh } = useAgentGuardSnapshot();
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
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
    return source.filter((event) => filter === "all" || event.category === filter).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [filter, liveEvents, snapshot]);

  if (loading && !snapshot) return <LoadingState />;

  return <section>
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="eyebrow">Runtime evidence</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Activity</h1><p className="mt-2 max-w-2xl text-sm text-[#64717c]">Recorded backend events plus live server-sent events for active runs.</p></div>
      <button onClick={refresh} className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold hover:bg-[#f3f4f5]">Refresh</button>
    </div>
    {error && <div className="mb-5"><ConnectionError message={error} onRetry={refresh} /></div>}
    <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
      {filters.map((item) => <button key={item} onClick={() => setFilter(item)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold capitalize ${filter === item ? "border-[#182a33] bg-[#182a33] text-white" : "bg-white text-[#64717c]"}`}>{item === "secret" ? "Secrets" : item}</button>)}
    </div>
    <div className="card overflow-hidden">
      {events.length === 0 ? <p className="p-8 text-center text-sm text-[#64717c]">No events match this filter.</p> : events.map((event) => <article key={event.id} className="grid gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[36px_minmax(0,1fr)_auto] sm:items-center">
        <span className={`grid size-9 place-items-center rounded-lg ${event.category === "policy" || event.allowed === false ? "bg-[#fff2df] text-[#8c5112]" : "bg-[#eceff1] text-[#276142]"}`}><EventIcon category={event.category} /></span>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{event.agentId}</span><span className="status">{event.category}.{event.action}</span>{event.allowed === false && <span className="status status-warn">Blocked</span>}</div><p className="mono mt-1 truncate text-xs text-[#64717c]">{event.resource ?? event.taskId}</p></div>
        <div className="text-left sm:text-right"><p className="text-xs text-[#64717c]">{new Date(event.timestamp).toLocaleString()}</p><p className="mt-1 text-xs font-semibold capitalize text-[#2c553e]">{statusLabel(event.severity ?? "info")}</p></div>
      </article>)}
    </div>
    {!snapshot && <p className="mt-3 text-xs text-[#64717c]">Showing sample events while the runtime backend is unavailable.</p>}
  </section>;
}



