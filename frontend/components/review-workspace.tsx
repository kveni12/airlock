"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { approveReview, getFiles, getReview, getReviewFindings, listFindings } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { FindingCard } from "./finding-card";
import { ActionButton, Empty, ErrorBanner, formatDateTime } from "./ui";

export function ReviewWorkspace({ reviewId }: { reviewId: string }) {
  const loader = useCallback(async (signal: AbortSignal) => {
    const review = await getReview(reviewId, signal);
    const [findings, runFindings, files] = await Promise.all([
      getReviewFindings(reviewId, signal),
      listFindings({ runId: review.runId }, signal),
      getFiles(review.runId, signal).catch(() => null)
    ]);
    const seen = new Set(findings.map((f) => f.id));
    return { review, findings, otherFindings: runFindings.filter((f) => !seen.has(f.id)), files };
  }, [reviewId]);
  const { data, error, refresh } = useResource(loader);
  const [showDiff, setShowDiff] = useState(true);

  if (error && !data) return <section><Back /><ErrorBanner message={error} onRetry={refresh} /></section>;
  if (!data) return <section><Back /><div className="skeleton mt-5 h-64" /></section>;

  const { review, findings, otherFindings, files } = data;
  const open = findings.filter((f) => f.status === "open" || f.status === "resolving" || f.status === "re_reviewing");
  const statusClass = review.status === "approved" ? "status-good" : review.status === "needs_human" ? "status-warn" : review.status === "failed" ? "status-bad" : "status-info";

  return <section>
    <Back />
    {error && <div className="mb-4"><ErrorBanner message={error} onRetry={refresh} /></div>}
    <div className="mb-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div>
        <p className="eyebrow">Review</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{review.taskId}</h1>
        <p className="mt-2 text-sm text-[#657068]">builder {review.builderAgentId} · reviewer {review.reviewerAgentId} · <Link className="underline" href={`/runs/${review.runId}`}>run {review.runId}</Link> · {formatDateTime(review.createdAt)}</p>
        {review.summary && <p className="mt-3 text-sm">{review.summary}</p>}
        {review.failureReason && <p className="mt-3 text-sm text-[#9a3d31]">{review.failureReason}</p>}
      </div>
      <aside className="card p-5">
        <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Status</span><span className={`status ${statusClass}`}>{review.status.replace("_", " ")}</span></div>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-[#657068]">Files reviewed</dt><dd className="font-semibold">{review.filesReviewed} / {review.filesTotal}</dd></div>
          <div className="flex justify-between"><dt className="text-[#657068]">Clean files</dt><dd className="font-semibold">{review.cleanFiles}</dd></div>
          <div className="flex justify-between"><dt className="text-[#657068]">Findings</dt><dd className="font-semibold">{findings.length} ({open.length} unresolved)</dd></div>
        </dl>
        <div className="mt-4 border-t pt-4">
          {review.status === "approved" ? <p className="text-sm text-[#14623f]">Approved {review.approvedAt && formatDateTime(review.approvedAt)}{review.approval?.actor && ` by ${review.approval.actor}`}{review.approval?.reason && <span className="block text-xs text-[#657068]">{review.approval.reason}</span>}</p>
            : <ActionButton disabled={review.status !== "needs_human" || open.length > 0} onClick={async () => { await approveReview(review.id, { actor: "human", reason: "Approved from review workspace" }); await refresh(); }}>Approve review{open.length > 0 && ` (${open.length} unresolved)`}</ActionButton>}
          {review.status === "needs_human" && open.length > 0 && <p className="mt-2 text-xs text-[#657068]">Resolve or dismiss every unresolved finding before approving.</p>}
        </div>
      </aside>
    </div>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,.8fr)]">
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Reviewer findings</h2>
        {findings.length === 0 && <Empty title="No reviewer findings" body="Every reviewed file came back clean." />}
        {findings.map((finding) => <FindingCard key={finding.id} finding={finding} onChanged={refresh} />)}
        {otherFindings.length > 0 && <>
          <h2 className="pt-4 text-lg font-semibold">Other findings on this run</h2>
          <p className="-mt-2 text-xs text-[#657068]">Policy and intent-drift findings detected by AgentGuard telemetry for the same run.</p>
          {otherFindings.map((finding) => <FindingCard key={finding.id} finding={finding} onChanged={refresh} />)}
        </>}
      </div>
      <div className="space-y-4">
        <div className="card p-5">
          <h2 className="font-semibold">File coverage</h2>
          <ul className="mt-3 divide-y text-sm">{review.fileReviews.map((file) => <li key={file.path} className="flex items-center justify-between gap-3 py-2"><span className="mono text-xs">{file.path}</span><span className={`status ${file.status === "clean" ? "status-good" : file.status === "finding" ? "status-warn" : "status-info"}`}>{file.status}{file.findingIds.length ? ` · ${file.findingIds.length}` : ""}</span></li>)}</ul>
          {review.fileReviews.length === 0 && <p className="mt-3 text-sm text-[#657068]">No files were reviewed.</p>}
        </div>
        {files?.diff && <div className="card p-5">
          <button onClick={() => setShowDiff((v) => !v)} className="flex w-full items-center justify-between font-semibold">Diff ({files.files.length} files){showDiff ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</button>
          {showDiff && <pre className="mono mt-3 max-h-[560px] overflow-auto rounded-lg bg-[#101913] p-4 text-xs leading-5 text-[#dfe7dc]">{files.diff}</pre>}
        </div>}
      </div>
    </div>
  </section>;
}

function Back() { return <Link href="/reviews" className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-[#536158]"><ArrowLeft className="size-4" />Back to reviews</Link>; }
