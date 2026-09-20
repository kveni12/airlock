"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ArrowLeft, Bot, Globe2, KeyRound, Plug, Terminal } from "lucide-react";
import { ConnectionError, LoadingState } from "./backend-state";
import { CapabilityItems, FileAccessTable, mcpServerLabels } from "./permission-display";
import { RunStatusBadge } from "./ui";
import { loadAgentCapability } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { RunRecord } from "@/lib/contracts";

export function AgentDetail({ agentId }: { agentId: string }) {
  const loader = useCallback((signal: AbortSignal) => loadAgentCapability(agentId, signal), [agentId]);
  const { data, loading, error, refresh } = useResource(loader, 15_000);
  if (loading && !data) return <LoadingState />;
  const run = data?.run ?? undefined;
  const permissions = data?.permissions ?? undefined;

  return <div className="mx-auto max-w-6xl space-y-6">
    <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-[#64717c]"><ArrowLeft className="size-4" />Back to agents</Link>
    {error ? <ConnectionError message={error} onRetry={refresh} /> : null}
    <AgentHeader run={run} agentId={agentId} />

    <section className="card p-5">
      <div className="mb-4"><p className="eyebrow">File access</p><h2 className="mt-1 text-lg font-semibold">What this agent can see and change</h2><p className="mt-1 text-sm text-[#64717c]">These are the configured folder rules from the latest run. A more specific folder rule overrides its parent.</p></div>
      <FileAccessTable permissions={permissions ?? {}} />
    </section>

    <section className="card overflow-hidden">
      <div className="border-b p-5"><p className="eyebrow">Other capabilities</p><h2 className="mt-1 text-lg font-semibold">Keys, services, network, and tools</h2></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] border-collapse text-left">
        <thead className="bg-[#f0f2f3] text-[11px] uppercase tracking-[.08em] text-[#64717c]"><tr><th className="px-5 py-3">Capability</th><th className="px-5 py-3">Granted access</th><th className="px-5 py-3">What it means</th></tr></thead>
        <tbody className="divide-y">
          <CapabilityRow icon={KeyRound} label="Keys" items={permissions?.secrets ?? []} empty="No keys" explanation="Only these named environment variables are injected into the sandbox." />
          <CapabilityRow icon={Plug} label="MCP servers" items={permissions ? mcpServerLabels(permissions, true) : []} empty="No MCP servers" explanation="These MCP servers are declared for the run; use is recorded from agent telemetry." />
          <CapabilityRow icon={Globe2} label="Network" items={permissions?.network ?? []} empty="No internet hosts allowed" explanation="Only these hosts are allowed through the network proxy when the runtime can enforce it." />
          <CapabilityRow icon={Terminal} label="Tools" items={permissions?.tools ?? []} empty="No tools declared" explanation="These tools are declared for the run; unlisted use is flagged when telemetry exposes it." />
        </tbody>
      </table></div>
    </section>
  </div>;
}

function AgentHeader({ run, agentId }: { run?: RunRecord; agentId: string }) {
  return <header className="card flex flex-wrap items-start justify-between gap-4 p-5">
    <div className="flex min-w-0 items-center gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-xl bg-[#182a33] text-[#ecdcc8]"><Bot /></span><div className="min-w-0"><p className="eyebrow">{run?.agent?.kind ?? "Agent"}</p><h1 className="mt-1 truncate text-3xl font-semibold tracking-[-.04em]">{displayAgent(run, agentId)}</h1><p className="mono mt-1 text-xs text-[#64717c]">{agentId}</p><p className="mt-1 text-sm text-[#64717c]">{run?.agent?.prompt ?? "No observed run for this agent yet."}</p></div></div>
    {run ? <div className="flex flex-wrap items-center gap-2"><RunStatusBadge status={run.status} /><span className="status">{run.runtimeProvider}</span><Link href={`/runs/${run.id}`} className="text-xs font-semibold text-[#19734a] underline decoration-dotted">Open latest run</Link></div> : null}
  </header>;
}

function CapabilityRow({ icon: Icon, label, items, empty, explanation }: { icon: typeof KeyRound; label: string; items: string[]; empty: string; explanation: string }) {
  return <tr className="align-top"><th scope="row" className="w-48 px-5 py-4"><span className="inline-flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-[#64717c]" />{label}</span></th><td className="w-[42%] px-5 py-4"><CapabilityItems items={items} empty={empty} /></td><td className="px-5 py-4 text-sm leading-5 text-[#64717c]">{explanation}</td></tr>;
}

function displayAgent(run: RunRecord | undefined, fallback: string) {
  const names: Record<string, string> = { claude_code: "Claude Code", codex: "OpenAI Codex", opencode: "OpenCode", cursor: "Cursor Agent", devin: "Devin" };
  return names[run?.agent?.kind ?? ""] ?? fallback;
}
