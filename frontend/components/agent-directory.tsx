"use client";

import Link from "next/link";
import { ArrowRight, Bot, FolderKey, Globe2, KeyRound, Server, Terminal } from "lucide-react";
import { ConnectionError, EmptyState, LoadingState } from "./backend-state";
import { useAgentGuardSnapshot } from "@/lib/use-snapshot";
import { permissionCount, statusLabel } from "@/lib/mappers.js";
import type { PermissionSnapshot, RunRecord } from "@/lib/contracts";

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
      const highRisk = events.some((event) => event.category === "policy" && ["high", "critical"].includes(event.severity ?? ""));
      return <div key={run.agentId} className="card p-6"><div className="flex items-start justify-between gap-4"><div className="flex gap-3"><span className="grid size-10 place-items-center rounded-lg bg-[#17261c] text-[#f5ffd7]"><Bot className="size-5" /></span><div><h2 className="font-semibold">{displayAgent(run)}</h2><p className="mt-1 text-sm text-[#657068]">{run.agent?.kind ?? "generic"} · {run.agent?.prompt ?? run.taskId}</p></div></div><span className={`status ${highRisk ? "status-warn" : "status-good"}`}>{highRisk ? "High risk" : statusLabel(run.status)}</span></div>
        <div className="mt-5 flex flex-wrap gap-2"><PermissionChips permissions={permissions} /></div>
        <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm"><span className="text-[#657068]">{permissionCount(permissions)} configured capabilities</span><Link href={`/agents/${encodeURIComponent(run.agentId)}`} className="inline-flex items-center gap-2 font-semibold text-[#19734a]">Inspect access <ArrowRight className="size-4" /></Link></div>
      </div>;
    })}</div>
  </Page>;
}

function Page({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-7xl space-y-6"><div><p className="eyebrow">Capability inventory</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">Agents</h1><p className="mt-2 text-[#657068]">The latest run and configured access for every observed agent.</p></div>{children}</div>; }
function latestRunPerAgent(runs: RunRecord[]) { return [...new Map(runs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((run) => [run.agentId, run])).values()]; }
function displayAgent(run: RunRecord) { const names: Record<string, string> = { claude_code: "Claude Code", codex: "OpenAI Codex", cursor: "Cursor Agent", devin: "Devin" }; return names[run.agent?.kind ?? ""] ?? run.agentId; }
const demoPermissions: PermissionSnapshot = { filesystem: [{ path: "/workspace/src", access: "read_write" }], network: ["oauth.googleapis.com"], secrets: ["GOOGLE_CLIENT_SECRET"], mcpServers: ["github"], tools: ["git", "npm", "shell"] };
function PermissionChips({ permissions }: { permissions: PermissionSnapshot }) { const items = [
  ...(permissions.mcpServers ?? []).map((value) => ({ icon: Server, value: `${value} MCP` })),
  ...(permissions.filesystem ?? []).map((item) => ({ icon: FolderKey, value: item.path })),
  ...(permissions.secrets ?? []).map((value) => ({ icon: KeyRound, value })),
  ...(permissions.network ?? []).map((value) => ({ icon: Globe2, value })),
  ...(permissions.tools ?? []).map((value) => ({ icon: Terminal, value }))
]; return <>{items.slice(0, 7).map(({ icon: Icon, value }) => <span key={`${Icon.displayName}-${value}`} className="inline-flex items-center gap-1.5 rounded-md border bg-[#e9ede5]/60 px-2.5 py-1.5 text-xs"><Icon className="size-3.5" />{value}</span>)}</>; }
