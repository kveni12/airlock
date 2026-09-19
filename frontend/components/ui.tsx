"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { AlignmentStatus, EventSeverity, EvidenceVerification, FindingStatus, RunStatus } from "@/lib/contracts";

export function AlignmentBadge({ status, large }: { status: AlignmentStatus | undefined; large?: boolean }) {
  const cls = status === "aligned" ? "status-good" : status === "warning" ? "status-warn" : status === "conflict" ? "status-bad" : "";
  const Icon = status === "aligned" ? CheckCircle2 : status === "warning" ? AlertTriangle : status === "conflict" ? XCircle : CircleDashed;
  return <span className={`status ${cls} ${large ? "px-3 py-1.5 text-sm" : ""}`}><Icon className={`${large ? "size-4" : "size-3.5"} mr-1.5`} />{status ?? "unknown"}</span>;
}

export function SeverityBadge({ severity }: { severity: EventSeverity }) {
  const cls = severity === "critical" || severity === "high" ? "status-bad" : severity === "medium" ? "status-warn" : "status-info";
  return <span className={`status ${cls}`}>{severity}</span>;
}

export function VerificationBadge({ verification }: { verification: EvidenceVerification | "unavailable" | undefined }) {
  if (!verification) return null;
  const cls = verification === "independent" ? "status-good" : verification === "agent_reported" ? "status-info" : verification === "unavailable" ? "status-muted" : "status-warn";
  return <span className={`status ${cls} mono`} title={verificationHelp(verification)}>{verification.replace("_", " ")}</span>;
}

export function verificationHelp(verification: EvidenceVerification | "unavailable"): string {
  switch (verification) {
    case "independent": return "Observed directly by Periscope telemetry (filesystem, git, proxy, runtime).";
    case "agent_reported": return "Reported by the agent itself; not independently verified.";
    case "inferred": return "Derived by analysis; not a direct observation.";
    case "unavailable": return "Periscope cannot observe this channel; absence is not evidence.";
  }
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const cls = status === "completed" ? "status-good" : status === "failed" ? "status-bad" : ["running", "starting", "pending", "stopping"].includes(status) ? "status-info" : "";
  return <span className={`status ${cls}`}>{status}</span>;
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  const cls = status === "resolved" ? "status-good" : status === "dismissed" ? "status-muted" : status === "open" ? "status-warn" : "status-info";
  return <span className={`status ${cls}`}>{status.replace("_", " ")}</span>;
}

export function Section({ title, eyebrow, action, children, className = "" }: { title: string; eyebrow?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`card p-5 ${className}`}>
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 className="mt-1 text-lg font-semibold">{title}</h2></div>
      {action}
    </div>
    {children}
  </section>;
}

export function Chips({ items, empty = "none", mono = true }: { items: string[]; empty?: string; mono?: boolean }) {
  if (!items.length) return <span className="text-sm text-[#64717c]">{empty}</span>;
  return <div className="flex flex-wrap gap-1.5">{items.map((item) => <span key={item} className={`rounded-md border bg-[#e6e9eb]/60 px-2 py-1 text-xs ${mono ? "mono" : ""}`}>{item}</span>)}</div>;
}

/** Shared square filter chips so Runs / Reviews / Activity look the same. */
export function FilterChips<T extends string>({ items, value, onChange, label }: { items: readonly T[]; value: T; onChange: (value: T) => void; label?: (item: T) => string }) {
  return <div className="flex gap-2 overflow-x-auto">{items.map((item) => <button key={item} type="button" onClick={() => onChange(item)} className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold ${label ? "" : "capitalize"} ${value === item ? "border-[#182a33] bg-[#182a33] text-white" : "bg-white text-[#64717c] hover:bg-[#f3f4f5]"}`}>{label ? label(item) : item.replace(/_/g, " ")}</button>)}</div>;
}

export function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-1 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-3"><dt className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">{label}</dt><dd className="min-w-0 text-sm">{children}</dd></div>;
}

export function ActionButton({ children, onClick, variant = "primary", disabled, confirm }: { children: React.ReactNode; onClick: () => Promise<unknown> | void; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cls = variant === "primary" ? "bg-[#d1b191] text-[#182a33] hover:bg-[#c4a17d]" : variant === "danger" ? "border border-[#e3a59b] bg-white text-[#9a3d31] hover:bg-[#fff1ee]" : "border bg-white hover:bg-[#f3f4f5]";
  return <span className="inline-flex flex-col items-start gap-1">
    <button
      disabled={disabled || busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        setError(null);
        try { await onClick(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); }
      }}
      className={`rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >{busy ? "Working…" : children}</button>
    {error && <span className="max-w-xs text-xs text-[#9a3d31]">{error}</span>}
  </span>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="flex items-center justify-between gap-3 rounded-xl border border-[#e3a59b] bg-[#fff1ee] p-4 text-sm text-[#7a2d24]"><span>{message}</span>{onRetry && <button onClick={onRetry} className="rounded-lg border border-[#e3a59b] bg-white px-3 py-1.5 text-xs font-semibold">Retry</button>}</div>;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed p-6 text-center text-sm text-[#64717c]"><p className="font-semibold text-[#14212a]">{title}</p>{body && <p className="mt-1">{body}</p>}{action && <div className="mt-3 flex justify-center">{action}</div>}</div>;
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString();
}
