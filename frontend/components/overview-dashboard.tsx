"use client";

import Link from "next/link";
import { Activity, ArrowRight, Bot, CircleAlert, FileCode2, ScanLine } from "lucide-react";
import { ConnectionError, EmptyState, LoadingState } from "./backend-state";
import { useAgentGuardSnapshot } from "@/lib/use-snapshot";
import { statusLabel, summarizeSnapshot } from "@/lib/mappers.js";
import { VerdictBadge, isSmokeRun } from "./runs-list";

const demoMetrics = { activeAgents: 4, policyAlerts: 2, filesChanged: 10, recordedEvents: 86 };

export function OverviewDashboard() {
  const { snapshot, loading, error, refresh } = useAgentGuardSnapshot();
  if (loading && !snapshot) return <Page><LoadingState /></Page>;
  const metrics = snapshot ? summarizeSnapshot(snapshot) : demoMetrics;
  const sorted = (snapshot?.runs ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const needsAttention = sorted.find((run) => run.verdict && (run.verdict.status === "conflict" || run.verdict.status === "warning" || run.verdict.reviewStatus === "needs_human"));
  const latestRun = needsAttention ?? sorted.find((run) => !isSmokeRun(run)) ?? sorted[0];
  const latestPolicyEvent = snapshot ? Object.values(snapshot.eventsByRun).flat().filter((event) => event.category === "policy").sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] : undefined;
  const policyRunIds = snapshot ? new Set(Object.values(snapshot.eventsByRun).flat().filter((event) => event.category === "policy").map((event) => event.runId)) : new Set<string>();

  return <Page>
    {error ? <ConnectionError message={error} onRetry={refresh} /> : null}
    {snapshot && snapshot.runs.length === 0 ? <EmptyState title="No agent runs yet" body="Create a request and start a run from the New request page, or seed data with npm run demo:intent." /> : <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Bot} label="Active agents" value={metrics.activeAgents} detail="Pending, starting, or running" />
        <Metric icon={CircleAlert} label="Policy alerts" value={metrics.policyAlerts} detail={policyRunIds.size ? `Across ${policyRunIds.size} run${policyRunIds.size === 1 ? "" : "s"} · view in Activity` : "Derived from policy events"} warn={metrics.policyAlerts > 0} href={metrics.policyAlerts > 0 ? "/activity?category=policy" : undefined} />
        <Metric icon={FileCode2} label="Files changed" value={metrics.filesChanged} detail="Across recorded runs" />
        <Metric icon={ScanLine} label="Recorded events" value={metrics.recordedEvents} detail="Persisted runtime evidence" />
      </section>
      <section className="mt-5 grid gap-4 lg:grid-cols-[1.25fr_.75fr]">
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4"><div><p className="text-sm text-[#64717c]">{needsAttention ? "Latest run needing attention" : "Latest run"}</p><h2 className="mt-1 text-xl font-semibold">{latestRun?.agent?.prompt || latestRun?.taskId || "Add OAuth support"}</h2><p className="mono mt-1 text-xs text-[#64717c]">{latestRun?.repoBranch || "agent/oauth-support"}</p></div><span className="flex flex-wrap justify-end gap-2">{latestRun && <VerdictBadge run={latestRun} />}<span className={`status ${latestRun?.status === "failed" ? "status-warn" : "status-info"}`}>{latestRun ? statusLabel(latestRun.status) : "Demo"}</span></span></div>
          <div className="mt-6 grid grid-cols-3 gap-3"><Mini value={latestRun?.gitSummary?.filesChanged ?? 10} label="Files" /><Mini value={latestRun?.gitSummary ? `+${latestRun.gitSummary.insertions}` : "+428"} label="Insertions" /><Mini value={latestRun?.runtimeProvider ?? "lima"} label="Runtime" /></div>
          <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm"><span><span className="text-[#64717c]">Agent</span> {latestRun?.agentId ?? "claude_builder_001"}</span><span className="flex gap-4">{latestRun && <Link href={`/runs/${latestRun.id}`} className="inline-flex items-center gap-2 font-semibold text-[#19734a]">Run detail <ArrowRight className="size-4" /></Link>}<Link href="/activity" className="inline-flex items-center gap-2 font-semibold text-[#19734a]">View activity <ArrowRight className="size-4" /></Link></span></div>
        </div>
        <div className={`card p-6 ${latestPolicyEvent || !snapshot ? "border-amber-300 bg-amber-50/50" : ""}`}><div className="flex gap-3"><Activity className="mt-0.5 size-5 text-[#9a5a13]" /><div className="min-w-0"><p className="text-sm text-[#64717c]">Latest policy signal</p><h2 className="mt-2 font-semibold">{latestPolicyEvent?.action ? statusLabel(latestPolicyEvent.action) : snapshot ? "No policy violations" : "Unexpected secret access"}</h2><p className="mono mt-2 truncate text-sm leading-6 text-[#64717c]">{latestPolicyEvent?.resource || (snapshot ? "All recorded activity is within declared policy." : "Demo evidence: GOOGLE_CLIENT_SECRET was accessed outside declared intent.")}</p>{latestPolicyEvent && <Link href={`/runs/${latestPolicyEvent.runId}?tab=findings`} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#19734a]">Open run findings <ArrowRight className="size-4" /></Link>}</div></div></div>
      </section>
    </>}
  </Page>;
}

function Page({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-7xl space-y-6"><div><p className="eyebrow">System posture</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">Overview</h1><p className="mt-2 text-[#64717c]">Live runtime posture from the Periscope backend.</p></div>{children}</div>; }
function Metric({ icon: Icon, label, value, detail, warn = false, href }: { icon: typeof Bot; label: string; value: string | number; detail: string; warn?: boolean; href?: string }) {
  const body = <><div className="flex justify-between"><div><p className="text-sm text-[#64717c]">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></div><span className="grid size-9 place-items-center rounded-lg bg-[#e6e9eb]"><Icon className="size-4" /></span></div><p className="mt-4 text-xs text-[#64717c]">{detail}</p></>;
  const cls = `card block p-5 ${warn ? "border-amber-300" : ""}`;
  return href ? <Link href={href} className={`${cls} transition hover:-translate-y-0.5 hover:shadow-sm`}>{body}</Link> : <div className={cls}>{body}</div>;
}
function Mini({ value, label }: { value: string | number; label: string }) { return <div className="rounded-lg bg-[#e6e9eb]/70 p-3"><p className="mono font-semibold">{value}</p><p className="mt-1 text-xs text-[#64717c]">{label}</p></div>; }
