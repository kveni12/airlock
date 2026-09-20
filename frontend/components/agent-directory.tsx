"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ArrowRight, Bot, Eye, EyeOff, Globe2, KeyRound, Pencil, Plug, Terminal } from "lucide-react";
import { ConnectionError, EmptyState, LoadingState } from "./backend-state";
import { RunStatusBadge } from "./ui";
import { CapabilityItems, FileAccessItems, mcpServerLabels } from "./permission-display";
import { loadAgentCapabilities } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { PermissionSnapshot, RunRecord } from "@/lib/contracts";

const demo = [{ id: "claude_builder_001", agent: { kind: "claude_code", prompt: "Add OAuth support" }, status: "running", runtimeProvider: "lima" }] as RunRecord[];

export function AgentDirectory() {
  const loader = useCallback((signal: AbortSignal) => loadAgentCapabilities(signal), []);
  const { data: snapshot, loading, error, refresh } = useResource(loader, 15_000);
  if (loading && !snapshot) return <Page><LoadingState /></Page>;
  const runs = snapshot?.runs.length ? snapshot.runs : demo;
  if (snapshot && snapshot.runs.length === 0) return <Page><EmptyState title="No agents observed" body="Agents appear after the backend creates its first run." /></Page>;

  return <Page>
    {error ? <ConnectionError message={error} onRetry={refresh} /> : null}
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1420px] border-collapse text-left">
          <thead className="border-b bg-[#f0f2f3] text-[11px] uppercase tracking-[.08em] text-[#64717c]">
            <tr>
              <Header icon={Bot} title="Agent" subtitle="Latest run" />
              <Header icon={Eye} title="Read only" subtitle="Can view" />
              <Header icon={Pencil} title="Can change" subtitle="Can edit" />
              <Header icon={EyeOff} title="No access" subtitle="Hidden" />
              <Header icon={KeyRound} title="Secrets" subtitle="Injected environment variables" />
              <Header icon={Plug} title="MCP servers" subtitle="Declared" />
              <Header icon={Globe2} title="Network" subtitle="Allowed hosts" />
              <Header icon={Terminal} title="Tools" subtitle="Declared" />
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.map((run) => {
              const permissions = snapshot?.permissionsByRun[run.id] ?? demoPermissions;
              const events = snapshot?.eventsByRun[run.id] ?? [];
              const highRisk = events.some((event) => event.category === "policy" && ["high", "critical"].includes(event.severity ?? ""));
              return <tr key={run.agentId} className="align-top transition-colors hover:bg-[#f7f8f8]">
                <td className="w-64 px-4 py-4">
                  <div className="flex gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#182a33] text-[#ecdcc8]"><Bot className="size-4" /></span><div className="min-w-0"><p className="font-semibold">{displayAgent(run)}</p><p className="mono mt-0.5 text-[11px] text-[#64717c]">{run.agentId}</p><p className="mt-1 max-w-56 truncate text-xs text-[#64717c]" title={run.agent?.prompt ?? run.taskId}>{run.agent?.prompt ?? run.taskId}</p></div></div>
                </td>
                <PermissionColumn><FileAccessItems permissions={permissions} access="read" limit={3} /></PermissionColumn>
                <PermissionColumn><FileAccessItems permissions={permissions} access="read_write" limit={3} /></PermissionColumn>
                <PermissionColumn><FileAccessItems permissions={permissions} access="none" limit={3} /></PermissionColumn>
                <PermissionColumn><CapabilityItems items={permissions.secrets ?? []} empty="No secrets" limit={3} /></PermissionColumn>
                <PermissionColumn><CapabilityItems items={mcpServerLabels(permissions)} empty="No MCP" limit={3} /></PermissionColumn>
                <PermissionColumn><CapabilityItems items={permissions.network ?? []} empty="No hosts" limit={3} /></PermissionColumn>
                <PermissionColumn><CapabilityItems items={permissions.tools ?? []} empty="No tools" limit={3} /></PermissionColumn>
                <td className="w-32 px-4 py-4">
                  {highRisk ? <span className="status status-warn">High risk</span> : <RunStatusBadge status={run.status} />}
                  <Link href={`/agents/${encodeURIComponent(run.agentId)}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#19734a]">View details <ArrowRight className="size-3.5" /></Link>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
    <p className="text-xs text-[#64717c]">Permissions shown here come from each agent&apos;s latest run. File access is enforced according to the selected runtime; MCP and tool use may rely on agent-reported telemetry.</p>
  </Page>;
}

function Header({ icon: Icon, title, subtitle }: { icon: typeof Bot; title: string; subtitle: string }) {
  return <th className="px-4 py-3 font-semibold"><span className="flex items-center gap-1.5 text-[#3a4650]"><Icon className="size-3.5" />{title}</span><span className="mt-0.5 block normal-case tracking-normal text-[#98a4ad]">{subtitle}</span></th>;
}

function PermissionColumn({ children }: { children: React.ReactNode }) { return <td className="w-36 px-4 py-4">{children}</td>; }
function Page({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-[1600px] space-y-6"><div><p className="eyebrow">Capability inventory</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">Agents</h1><p className="mt-2 max-w-3xl text-[#64717c]">What each agent can read, change, and connect to, based on its latest run.</p></div>{children}</div>; }
function displayAgent(run: RunRecord) { const names: Record<string, string> = { claude_code: "Claude Code", codex: "OpenAI Codex", opencode: "OpenCode", cursor: "Cursor Agent", devin: "Devin" }; return names[run.agent?.kind ?? ""] ?? run.agentId; }
const demoPermissions: PermissionSnapshot = { filesystem: [{ path: "/workspace", access: "read" }, { path: "/workspace/src", access: "read_write" }, { path: "/workspace/.env", access: "none" }], network: ["oauth.googleapis.com"], secrets: ["GOOGLE_CLIENT_SECRET"], mcpServers: ["github"], tools: ["git", "npm", "shell"] };
