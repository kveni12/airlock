"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, ChevronUp, FlaskConical, X } from "lucide-react";
import type { ReviewFinding, ReviewTask } from "../lib/review-data";

type FindingState = "open" | "accepted" | "dismissed";

function FindingCard({ finding, state, onChange }: { finding: ReviewFinding; state: FindingState; onChange: (state: FindingState) => void }) {
  return <article className="rounded-xl border bg-white p-4">
    <div className="flex flex-wrap items-center gap-2"><span className={`status ${finding.severity === "critical" || finding.severity === "high" ? "status-warn" : "status-info"}`}>{finding.severity}</span><span className="mono text-xs text-[#657068]">{finding.file}:{finding.line}</span>{state !== "open" && <span className="status status-good">{state}</span>}</div>
    <h3 className="mt-3 font-semibold">{finding.title}</h3><p className="mt-2 text-sm leading-6 text-[#59635d]">{finding.explanation}</p>
    <div className="mt-3 rounded-lg bg-[#f1f4ee] p-3 text-sm"><span className="font-semibold">Recommendation: </span>{finding.recommendation}</div>
    <div className="mt-4 flex gap-2"><button onClick={() => onChange("accepted")} className="flex items-center gap-2 rounded-lg bg-[#172018] px-3 py-2 text-xs font-semibold text-white"><Check className="size-3.5" />Accept</button><button onClick={() => onChange("dismissed")} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"><X className="size-3.5" />Dismiss</button></div>
  </article>;
}

export function ReviewWorkspace({ review }: { review: ReviewTask }) {
  const [states, setStates] = useState<Record<string, FindingState>>({});
  const [showDiff, setShowDiff] = useState(true);
  const [decision, setDecision] = useState<"approved" | "changes_requested" | null>(null);
  const resolved = review.findings.filter((finding) => (states[finding.id] ?? "open") !== "open").length;

  return <section>
    <Link href="/reviews" className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-[#536158]"><ArrowLeft className="size-4" />Back to reviews</Link>
    <div className="mb-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]"><div><p className="eyebrow">Review prototype</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{review.title}</h1><p className="mt-2 text-sm text-[#657068]">{review.repository} · {review.branch} · {review.author}</p></div><div className="card flex items-center justify-between p-4"><div><p className="text-xs uppercase tracking-wider text-[#657068]">Risk score</p><p className="mt-1 text-3xl font-semibold">{review.riskScore}</p></div><div className="text-right text-xs text-[#657068]"><p>{review.filesChanged} files</p><p className="mt-1"><span className="text-[#19734a]">+{review.additions}</span> / <span className="text-[#9a3d31]">−{review.deletions}</span></p></div></div></div>
    <div className="mb-6 flex gap-3 rounded-xl border border-[#ebc77e] bg-[#fff8e8] p-4 text-sm text-[#714717]"><FlaskConical className="mt-0.5 size-5 shrink-0" /><p><strong>Simulation only.</strong> Finding resolution and final decisions stay in this browser session and are not sent to the runtime backend.</p></div>
    {decision && <div className="mb-6 rounded-xl border border-[#9bd7b5] bg-[#effaf3] p-4 text-sm text-[#14623f]">Decision recorded locally: <strong>{decision.replace("_", " ")}</strong>.</div>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,.8fr)]">
      <div><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Findings</h2><span className="text-xs text-[#657068]">{resolved}/{review.findings.length} resolved</span></div><div className="grid gap-3">{review.findings.length ? review.findings.map((finding) => <FindingCard key={finding.id} finding={finding} state={states[finding.id] ?? "open"} onChange={(state) => setStates((current) => ({ ...current, [finding.id]: state }))} />) : <div className="card p-7 text-sm text-[#657068]">No findings were generated for this review.</div>}</div></div>
      <aside><button onClick={() => setShowDiff((current) => !current)} className="card flex w-full items-center justify-between p-4 text-left font-semibold">Proposed diff {showDiff ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button>{showDiff && <pre className="mt-2 max-h-[520px] overflow-auto rounded-xl bg-[#101913] p-4 text-xs leading-6 text-[#dce8dc]"><code>{review.diff}</code></pre>}<div className="card mt-4 p-4"><p className="text-sm font-semibold">Final decision</p><p className="mt-1 text-xs leading-5 text-[#657068]">Prototype controls for the intended approval workflow.</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setDecision("changes_requested")} className="rounded-lg border px-3 py-2 text-xs font-semibold">Request changes</button><button onClick={() => setDecision("approved")} className="rounded-lg bg-[#dff869] px-3 py-2 text-xs font-semibold text-[#17200f]">Approve</button></div></div></aside>
    </div>
  </section>;
}
