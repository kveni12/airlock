"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";
import { listRuns } from "@/lib/api";
import type { RunRecord } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { Empty, ErrorBanner, RunStatusBadge, formatDateTime } from "./ui";

const purposes = ["all", "builder", "planner", "resolver"] as const;

export function RunsList() {
  const loader = useCallback((signal: AbortSignal) => listRuns(signal), []);
  const { data, loading, error, refresh } = useResource(loader);
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState<(typeof purposes)[number]>("all");

  const runs = useMemo(() => (data ?? [])
    .filter((run) => (purpose === "all" || (run.purpose ?? "builder") === purpose) && `${run.taskId} ${run.agentId} ${run.id}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data, purpose, query]);

  return <section>
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div><p className="eyebrow">Evidence chain</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Runs</h1><p className="mt-2 max-w-2xl text-sm text-[#64717c]">Every sandboxed agent run, with its human request, declared intent, permissions, observed behavior and result.</p></div>
      <Link href="/requests/new" className="inline-flex items-center gap-2 rounded-lg bg-[#d1b191] px-4 py-2.5 text-sm font-semibold text-[#182a33] hover:bg-[#c4a17d]"><Plus className="size-4" />New request</Link>
    </div>
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={refresh} /></div>}
    <div className="mb-5 flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-[#76838d]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, agent, or run id" className="w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[#19734a]" /></label>
      <div className="flex gap-2 overflow-x-auto">{purposes.map((item) => <button key={item} onClick={() => setPurpose(item)} className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold capitalize ${purpose === item ? "border-[#182a33] bg-[#182a33] text-white" : "bg-white text-[#64717c]"}`}>{item}</button>)}</div>
    </div>
    <div className="grid gap-3">
      {runs.map((run) => <RunRow key={run.id} run={run} />)}
      {!loading && runs.length === 0 && (data?.length
        ? <Empty title="No runs match these filters" body={`${data.length} run${data.length === 1 ? "" : "s"} hidden by the current search or purpose filter.`} action={<button onClick={() => { setQuery(""); setPurpose("all"); }} className="rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]">Clear filters</button>} />
        : <Empty title="No runs yet" body="Create a request and start a run to see its evidence chain here." action={<Link href="/requests/new" className="rounded-lg bg-[#d1b191] px-3 py-2 text-xs font-semibold text-[#182a33] hover:bg-[#c4a17d]">New request</Link>} />)}
      {loading && !data && [0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)}
    </div>
  </section>;
}

function RunRow({ run }: { run: RunRecord }) {
  return <Link href={`/runs/${run.id}`} className="card group grid gap-3 p-5 transition hover:-translate-y-0.5 hover:border-[#98a4ad] hover:shadow-sm sm:grid-cols-[minmax(0,1fr)_auto]">
    <div>
      <div className="flex flex-wrap items-center gap-2"><RunStatusBadge status={run.status} /><span className="status capitalize">{run.purpose ?? "builder"}</span>{run.workspaceAccess === "read_only" && <span className="status status-muted">read-only workspace</span>}<span className="mono text-xs text-[#64717c]">{run.runtimeProvider}</span></div>
      <h2 className="mt-3 text-lg font-semibold">{run.taskId}</h2>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#64717c]"><span>agent <b className="text-[#14212a]">{run.agentId}</b></span><span className="mono">{run.id}</span><span>{formatDateTime(run.createdAt)}</span>{run.gitSummary && <span>{run.gitSummary.filesChanged} files <span className="text-[#19734a]">+{run.gitSummary.insertions}</span> <span className="text-[#9a3d31]">−{run.gitSummary.deletions}</span></span>}</div>
    </div>
    <div className="flex items-center gap-3 sm:justify-end text-xs text-[#64717c]">{run.requestId ? "request" : "no request"} · {run.intentId ? "intent" : "no intent"}<ArrowRight className="size-5 transition group-hover:translate-x-1" /></div>
  </Link>;
}
