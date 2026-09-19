"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Bot, FolderKey, Globe2, KeyRound, Server, Terminal } from "lucide-react";
import { ConnectionError, EmptyState, LoadingState } from "./backend-state";
import { useAgentGuardSnapshot } from "@/lib/use-snapshot";
import { permissionCount, statusLabel } from "@/lib/mappers.js";
import type { AgentEvent, PermissionSnapshot, RunRecord } from "@/lib/contracts";

/** Why an agent is flagged high risk, from its policy events across all runs (e.g. "wrote outside scope in 1 run"). */
function riskReason(runs: RunRecord[], eventsByRun: Record<string, AgentEvent[]>): string | null {
  const perRun = runs.map((run) => (eventsByRun[run.id] ?? []).filter((event) => event.category === "policy" && ["high", "critical"].includes(event.severity ?? "")));
  const flagged = perRun.filter((events) => events.length).length;
  if (!flagged) return null;
  const all = perRun.flat();
  const kinds = new Set(all.map((event) => /write|filesystem|path/.test(event.action) ? "wrote outside scope" : /network|host|egress/.test(event.action) ? "reached a blocked host" : /secret/.test(event.action) ? "touched a secret" : "broke policy"));
  return `${[...kinds].join(", ")} in ${flagged} run${flagged === 1 ? "" : "s"}`;
}

const demo = [{ id: "claude_builder_001", agent: { kind: "claude_code", prompt: "Add OAuth support" }, status: "running", runtimeProvider: "lima" }] as RunRecord[];

export function AgentDirectory() {
  const { snapshot, loading, error, refresh } = useAgentGuardSnapshot();
  if (loading && !snapshot) return <Page><LoadingState /></Page>;
  const runs = snapshot?.runs.length ? latestRunPerAgent(snapshot.runs) : demo;
  if (snapshot && runs.length === 0) return <Page><EmptyState title="No agents observed" body="Agents appear after the backend creates its first run." /></Page>;
  return <Page>
    {error ? <ConnectionError message={error} onRetry={refresh} /> : null}
    <div className="grid gap-4 lg:grid-cols-2">{runs.map((run) => {
      const permissions = snapshot?.permissionsByRun[run.id] ?? demoPermissions;
      const events = snapshot?.eventsByRun[run.id] ?? [];
      const reason = snapshot ? riskReason(snapshot.runs.filter((item) => item.agentId === run.agentId), snapshot.eventsByRun) : (events.some((event) => event.category === "policy") ? "policy violation" : null);
      return <div key={run.agentId} className="card p-6"><div className="flex items-start justify-between gap-4"><div className="flex min-w-0 gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#182a33] text-[#ecdcc8]"><Bot className="size-5" /></span><div className="min-w-0"><h2 className="font-semibold">{displayAgent(run)}</h2><Description kind={run.agent?.kind ?? "generic"} text={run.agent?.prompt ?? run.taskId} /></div></div><span className={`status shrink-0 ${reason ? "status-warn" : "status-good"}`} title={reason ?? undefined}>{reason ? `High risk · ${reason}` : statusLabel(run.status)}</span></div>
        <div className="mt-5 flex flex-wrap gap-2"><PermissionChips permissions={permissions} /></div>
        <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm"><span className="text-[#64717c]">{permissionCount(permissions)} configured capabilities</span><Link href={`/agents/${encodeURIComponent(run.agentId)}`} className="inline-flex items-center gap-2 font-semibold text-[#19734a]">Inspect access <ArrowRight className="size-4" /></Link></div>
      </div>;
    })}</div>
  </Page>;
}

function Page({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-7xl space-y-6"><div><p className="eyebrow">Capability inventory</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">Agents</h1><p className="mt-2 text-[#64717c]">The latest run and configured access for every observed agent.</p></div>{children}</div>; }
function Description({ kind, text }: { kind: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90 || text.includes("\n");
  return <div className="mt-1 text-sm text-[#64717c]"><p className={open ? "whitespace-pre-wrap break-words" : "truncate"}>{kind} · {text}</p>{long && <button type="button" onClick={() => setOpen((value) => !value)} className="mt-0.5 text-xs font-semibold text-[#19734a] hover:underline">{open ? "Show less" : "Show full prompt"}</button>}</div>;
}

function latestRunPerAgent(runs: RunRecord[]) { return [...new Map(runs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((run) => [run.agentId, run])).values()]; }
function displayAgent(run: RunRecord) { const names: Record<string, string> = { claude_code: "Claude Code", codex: "OpenAI Codex", opencode: "OpenCode", cursor: "Cursor Agent", devin: "Devin" }; return names[run.agent?.kind ?? ""] ?? run.agentId; }
const demoPermissions: PermissionSnapshot = { filesystem: [{ path: "/workspace/src", access: "read_write" }], network: ["oauth.googleapis.com"], secrets: ["GOOGLE_CLIENT_SECRET"], mcpServers: ["github"], tools: ["git", "npm", "shell"] };
function PermissionChips({ permissions }: { permissions: PermissionSnapshot }) { const items = [
  ...(permissions.mcpServers ?? []).map((value) => ({ icon: Server, value: `${value} MCP` })),
  ...(permissions.filesystem ?? []).map((item) => ({ icon: FolderKey, value: item.path })),
  ...(permissions.secrets ?? []).map((value) => ({ icon: KeyRound, value })),
  ...(permissions.network ?? []).map((value) => ({ icon: Globe2, value })),
  ...(permissions.tools ?? []).map((value) => ({ icon: Terminal, value }))
]; return <>{items.slice(0, 7).map(({ icon: Icon, value }) => <span key={`${Icon.displayName}-${value}`} className="inline-flex items-center gap-1.5 rounded-md border bg-[#e6e9eb]/60 px-2.5 py-1.5 text-xs"><Icon className="size-3.5" />{value}</span>)}</>; }
