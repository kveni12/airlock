"use client";

import Link from "next/link";
import { ArrowLeft, Bot, Check, ShieldBan } from "lucide-react";
import { ConnectionError, LoadingState } from "./backend-state";
import { useAgentGuardSnapshot } from "@/lib/use-snapshot";

export function AgentDetail({ agentId }: { agentId: string }) {
  const { snapshot, loading, error, refresh } = useAgentGuardSnapshot();
  if (loading && !snapshot) return <LoadingState />;
  const run = snapshot?.runs.filter((item) => item.agentId === agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const permissions = run ? snapshot?.permissionsByRun[run.id] : undefined;
  return <div className="mx-auto max-w-6xl space-y-6">
    <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-[#657068]"><ArrowLeft className="size-4" />Back to agents</Link>
    {error ? <ConnectionError message={error} onRetry={refresh} /> : null}
    <div className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-xl bg-[#17261c] text-[#f5ffd7]"><Bot /></span><div><p className="eyebrow">{run?.agent?.kind ?? "Agent"}</p><h1 className="mt-1 text-3xl font-semibold tracking-[-.04em]">{run?.agentId ?? agentId}</h1><p className="mt-1 text-sm text-[#657068]">{run?.agent?.prompt ?? "No observed run for this agent yet."}</p></div></div>
    <div className="grid gap-4 md:grid-cols-2"><Section title="MCP servers" rows={(permissions?.mcpServers ?? []).map((value) => [value, "Available"])} /><Section title="Secrets / API keys" rows={(permissions?.secrets ?? []).map((value) => [value, "Available"])} /><Section title="Filesystem" rows={(permissions?.filesystem ?? []).map((item) => [item.path, item.access.replace("_", " + ")])} /><Section title="Network" rows={[...(permissions?.network ?? []).map((value) => [value, "Allowed"]), ["*", "Blocked"]]} /><Section title="Tools" rows={(permissions?.tools ?? []).map((value) => [value, "Enabled"])} /></div>
  </div>;
}

function Section({ title, rows }: { title: string; rows: string[][] }) { return <section className="card p-5"><h2 className="font-semibold">{title}</h2><div className="mt-4 divide-y">{rows.length ? rows.map(([resource, access]) => <div key={`${resource}-${access}`} className="flex items-center justify-between gap-4 py-3 text-sm"><span className="mono text-xs">{resource}</span><span className="flex items-center gap-1.5 text-[#657068]">{access === "Blocked" ? <ShieldBan className="size-4" /> : <Check className="size-4 text-[#19734a]" />}{access}</span></div>) : <p className="py-4 text-sm text-[#657068]">None configured</p>}</div></section>; }
