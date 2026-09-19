"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, FlaskConical, Search, ShieldAlert } from "lucide-react";
import { reviewTasks, type ReviewStatus } from "../lib/review-data";

const filters: Array<"all" | ReviewStatus> = ["all", "open", "in_review", "resolved"];

export function ReviewQueue() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const reviews = useMemo(() => reviewTasks.filter((review) => {
    const matchesFilter = filter === "all" || review.status === filter;
    const haystack = `${review.title} ${review.repository} ${review.author}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  }), [filter, query]);

  return <section>
    <div className="mb-7"><p className="eyebrow">Decision workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Reviews</h1><p className="mt-2 max-w-2xl text-sm text-[#657068]">Inspect proposed agent changes, findings, and diffs before approval.</p></div>
    <div className="mb-6 flex gap-3 rounded-xl border border-[#ebc77e] bg-[#fff8e8] p-4 text-sm text-[#714717]"><FlaskConical className="mt-0.5 size-5 shrink-0" /><div><p className="font-semibold">Prototype review data</p><p className="mt-1 text-[#805c2e]">The current runtime backend does not expose review or approval endpoints. These records and actions are intentionally simulated so the workflow can be designed and tested.</p></div></div>
    <div className="mb-5 flex flex-col gap-3 sm:flex-row">
      <label className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-[#738077]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, repository, or agent" className="w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[#19734a]" /></label>
      <div className="flex gap-2 overflow-x-auto">{filters.map((item) => <button key={item} onClick={() => setFilter(item)} className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold capitalize ${filter === item ? "border-[#101913] bg-[#101913] text-white" : "bg-white text-[#657068]"}`}>{item.replace("_", " ")}</button>)}</div>
    </div>
    <div className="grid gap-4">
      {reviews.map((review) => <Link href={`/reviews/${review.id}`} key={review.id} className="card group grid gap-4 p-5 transition hover:-translate-y-0.5 hover:border-[#9ca99d] hover:shadow-sm sm:grid-cols-[minmax(0,1fr)_auto]">
        <div><div className="flex flex-wrap items-center gap-2"><span className={`status ${review.status === "resolved" ? "status-good" : review.riskScore >= 70 ? "status-warn" : "status-info"}`}>{review.status.replace("_", " ")}</span><span className="mono text-xs text-[#657068]">{review.repository}</span></div><h2 className="mt-3 text-lg font-semibold">{review.title}</h2><p className="mt-2 max-w-3xl text-sm text-[#657068]">{review.summary}</p><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#657068]"><span>{review.author}</span><span>{review.filesChanged} files</span><span className="text-[#19734a]">+{review.additions}</span><span className="text-[#9a3d31]">−{review.deletions}</span><span>{review.findings.length} findings</span></div></div>
        <div className="flex items-center gap-4 sm:justify-end"><div className="text-right"><p className="text-2xl font-semibold">{review.riskScore}</p><p className="text-[10px] uppercase tracking-wider text-[#657068]">risk score</p></div>{review.riskScore >= 70 && <ShieldAlert className="size-5 text-[#a15b13]" />}<ArrowRight className="size-5 transition group-hover:translate-x-1" /></div>
      </Link>)}
      {reviews.length === 0 && <div className="card p-10 text-center text-sm text-[#657068]">No reviews match your search.</div>}
    </div>
  </section>;
}
