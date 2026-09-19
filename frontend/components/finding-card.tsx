"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dismissFinding, getResolution, resolveFinding } from "@/lib/api";
import type { Finding, ResolutionAttempt } from "@/lib/contracts";
import { ActionButton, FindingStatusBadge, SeverityBadge, VerificationBadge, formatDateTime } from "./ui";

const sourceLabel: Record<Finding["source"], string> = {
  policy: "Policy",
  intent_comparison: "Intent → Behavior",
  request_intent_comparison: "Request → Intent",
  reviewer: "Reviewer"
};

export function FindingCard({ finding, resolutions = [], onChanged, showRun }: { finding: Finding; resolutions?: ResolutionAttempt[]; onChanged: () => Promise<void> | void; showRun?: boolean }) {
  const [pending, setPending] = useState<ResolutionAttempt | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!pending || ["resolved", "failed"].includes(pending.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getResolution(pending.id);
        setPending(next);
        if (["resolved", "failed"].includes(next.status)) { window.clearInterval(timer); await onChanged(); }
      } catch { /* keep polling */ }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [pending, onChanged]);

  const latest = pending ?? resolutions.at(-1) ?? null;
  const evidence = finding.evidence;
  const canAct = finding.status === "open";
  const canResolve = canAct && Boolean(finding.file) && finding.source !== "request_intent_comparison";

  return <article className="card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={finding.severity} /><FindingStatusBadge status={finding.status} /><span className="status">{sourceLabel[finding.source]}</span><span className="mono text-xs text-[#64717c]">{finding.type}</span><VerificationBadge verification={evidence?.verification} /></div>
        <h3 className="mt-2 text-base font-semibold">{finding.title}</h3>
        <p className="mt-1 text-sm text-[#3a4650]">{finding.description}</p>
        {finding.file && <p className="mono mt-1 text-xs text-[#64717c]">{finding.file}{finding.line ? `:${finding.line}` : ""}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {canResolve && <ActionButton onClick={async () => { const attempt = await resolveFinding(finding.id, {}); setPending(attempt); await onChanged(); }}>Resolve in sandbox</ActionButton>}
        {canAct && <ActionButton variant="secondary" confirm="Dismiss this finding? The evidence stays on record." onClick={async () => { await dismissFinding(finding.id, { actor: "human", reason: "Dismissed from dashboard" }); await onChanged(); }}>Dismiss</ActionButton>}
        <button onClick={() => setOpen((v) => !v)} className="rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]">{open ? "Hide evidence" : "Evidence"}</button>
      </div>
    </div>

    {latest && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-[#f6f2ec] p-3 text-xs">
      <span className={`status ${latest.status === "resolved" ? "status-good" : latest.status === "failed" ? "status-bad" : "status-info"}`}>resolution {latest.status.replace("_", " ")}</span>
      {latest.resolutionRunId && <Link className="underline" href={`/runs/${latest.resolutionRunId}`}>resolver run</Link>}
      {latest.testResult && <span>tests {latest.testResult.passed ? "passed" : "failed"}</span>}
      {latest.reReviewResult && <span className="text-[#64717c]">{latest.reReviewResult.summary}</span>}
      {latest.failureReason && <span className="text-[#9a3d31]">{latest.failureReason}</span>}
      {latest.filesChanged.length > 0 && <span className="mono text-[#64717c]">{latest.filesChanged.join(", ")}</span>}
    </div>}

    {open && <dl className="mt-4 grid gap-3 border-t pt-4 text-sm md:grid-cols-2">
      {evidence?.humanRequestExcerpt && <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Human request</dt><dd className="mt-1 rounded-md border-l-2 border-[#d1b191] pl-3 italic">“{evidence.humanRequestExcerpt}”</dd></div>}
      {evidence?.agentIntentExcerpt && <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Agent intent</dt><dd className="mt-1 rounded-md border-l-2 border-[#a9cde1] pl-3 italic">“{evidence.agentIntentExcerpt}”</dd></div>}
      {evidence?.declaredResource !== undefined && <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Declared</dt><dd className="mono mt-1">{evidence.declaredResource || "(nothing declared)"}</dd></div>}
      {evidence?.observedResource && <div><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Observed</dt><dd className="mono mt-1">{evidence.observedResource}</dd></div>}
      {evidence?.eventIds && evidence.eventIds.length > 0 && <div className="md:col-span-2"><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Runtime events</dt><dd className="mono mt-1 break-all text-xs text-[#64717c]">{evidence.eventIds.join(", ")}</dd></div>}
      {evidence?.diffSnippet && <div className="md:col-span-2"><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Diff</dt><dd className="mono mt-1 max-h-64 overflow-auto whitespace-pre rounded-lg bg-[#182a33] p-3 text-xs text-[#dbe1e5]">{evidence.diffSnippet}</dd></div>}
      <div className="md:col-span-2 text-xs text-[#64717c]">
        {finding.id} · created {formatDateTime(finding.createdAt)}{finding.resolvedAt && ` · resolved ${formatDateTime(finding.resolvedAt)}`}{finding.dismissedAt && ` · dismissed ${formatDateTime(finding.dismissedAt)}${finding.dismissal?.reason ? ` (${finding.dismissal.reason})` : ""}`}
        {evidence?.requestId && <> · request {evidence.requestId}</>}{evidence?.intentId && <> · intent {evidence.intentId}</>}{showRun && finding.runId && <> · <Link className="underline" href={`/runs/${finding.runId}`}>run {finding.runId}</Link></>}
      </div>
    </dl>}
  </article>;
}
