"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { listReviews } from "@/lib/api";
import type { Review } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { Empty, ErrorBanner, formatDateTime } from "./ui";

const filters = ["all", "needs_human", "reviewing", "approved", "failed"] as const;

function statusClass(status: Review["status"]) {
  return status === "approved" ? "status-good" : status === "needs_human" ? "status-warn" : status === "failed" ? "status-bad" : "status-info";
}

export function ReviewQueue() {
  const loader = useCallback((signal: AbortSignal) => listReviews(signal), []);
  const { data, loading, error, refresh } = useResource(loader);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");

  const reviews = useMemo(() => (data ?? [])
    .filter((review) => (filter === "all" || review.status === filter) && `${review.taskId} ${review.builderAgentId} ${review.runId}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data, filter, query]);

  return <section>
    <div className="mb-7"><p className="eyebrow">Decision workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Reviews</h1><p className="mt-2 max-w-2xl text-sm text-[#657068]">Reviewer findings, resolutions and human approvals recorded by the Periscope backend. Approving here is persisted on the review.</p></div>
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={refresh} /></div>}
    <div className="mb-5 flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-[#738077]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, agent, or run id" className="w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[#19734a]" /></label>
      <div className="flex gap-2 overflow-x-auto">{filters.map((item) => <button key={item} onClick={() => setFilter(item)} className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold capitalize ${filter === item ? "border-[#101913] bg-[#101913] text-white" : "bg-white text-[#657068]"}`}>{item.replace("_", " ")}</button>)}</div>
    </div>
    <div className="grid gap-4">
      {reviews.map((review) => <Link href={`/reviews/${review.id}`} key={review.id} className="card group grid gap-4 p-5 transition hover:-translate-y-0.5 hover:border-[#9ca99d] hover:shadow-sm sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <div className="flex flex-wrap items-center gap-2"><span className={`status ${statusClass(review.status)}`}>{review.status.replace("_", " ")}</span><span className="mono text-xs text-[#657068]">run {review.runId}</span></div>
          <h2 className="mt-3 text-lg font-semibold">{review.taskId}</h2>
          <p className="mt-2 max-w-3xl text-sm text-[#657068]">{review.summary ?? review.failureReason ?? "Review in progress."}</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#657068]"><span>builder {review.builderAgentId}</span><span>reviewer {review.reviewerAgentId}</span><span>{review.filesReviewed}/{review.filesTotal} files reviewed</span><span>{review.findingIds.length} findings</span><span>{formatDateTime(review.createdAt)}</span></div>
        </div>
        <div className="flex items-center gap-4 sm:justify-end"><div className="text-right"><p className="text-2xl font-semibold">{review.filesWithFindings}</p><p className="text-[10px] uppercase tracking-wider text-[#657068]">files w/ findings</p></div><ArrowRight className="size-5 transition group-hover:translate-x-1" /></div>
      </Link>)}
      {!loading && reviews.length === 0 && <Empty title="No reviews" body={data?.length ? "No reviews match your filter." : "Complete a run and click “Start review” on its detail page."} />}
      {loading && !data && [0, 1].map((i) => <div key={i} className="skeleton h-28" />)}
    </div>
  </section>;
}
