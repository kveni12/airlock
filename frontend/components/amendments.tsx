"use client";

import { useCallback } from "react";
import { PauseCircle } from "lucide-react";
import { approveAmendment, denyAmendment, listRunAmendments } from "@/lib/api";
import type { IntentAmendmentChanges, PermissionSnapshot } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { ActionButton, Section, formatTime } from "./ui";

const CHANGE_LABEL: Record<keyof IntentAmendmentChanges, string> = {
  plannedActions: "Planned actions",
  expectedFiles: "Files",
  expectedDependencies: "Dependencies",
  expectedCommands: "Commands",
  expectedNetwork: "Network",
  expectedMcpServers: "MCP servers",
  expectedTools: "Tools",
  expectedSecrets: "Secrets"
};

const PERMISSION_LABEL: Record<keyof PermissionSnapshot, string> = {
  filesystem: "Files",
  network: "Internet hosts",
  secrets: "Secrets",
  mcpServers: "MCP servers",
  tools: "Tools"
};

/** Mid-run "may I also…" requests from the agent. The run is paused while any of them is pending. */
export function AmendmentsSection({ runId, onChanged }: { runId: string; onChanged: () => Promise<void> | void }) {
  const load = useCallback((signal: AbortSignal) => listRunAmendments(runId, signal), [runId]);
  const amendments = useResource(load, 4000);
  const items = amendments.data ?? [];
  if (!amendments.data || items.length === 0) return null;
  const pending = items.filter((a) => a.status === "pending").length;

  const decide = async (fn: typeof approveAmendment, id: string, reason: string) => {
    await fn(id, { actor: "human", reason });
    await amendments.refresh();
    await onChanged();
  };

  return <Section eyebrow="2b · Amendments" title="Agent asked for more" action={pending ? <span className="status status-warn"><PauseCircle className="mr-1 size-3.5" />{pending} pending · run paused</span> : <span className="status status-muted">{items.length} decided</span>}>
    <ul className="space-y-3">
      {items.map((a) => <li key={a.id} className={`rounded-xl border p-3 text-sm ${a.status === "pending" ? "border-[#e0b95c] bg-[#fdf7e7]" : "bg-white"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`status ${a.status === "approved" ? "status-good" : a.status === "denied" ? "status-bad" : "status-warn"}`}>{a.status}</span>
          <span className="text-xs text-[#64717c]">{formatTime(a.createdAt)} · via {a.channel === "agent_output" ? "agent output" : "control channel"}</span>
        </div>
        <p className="mt-2 italic">“{a.reason}”</p>
        <dl className="mt-2 grid gap-1 text-xs">
          {(Object.keys(a.changes) as Array<keyof IntentAmendmentChanges>).filter((k) => a.changes[k]?.length).map((k) => <div key={k}><dt className="inline font-semibold">{CHANGE_LABEL[k]}: </dt><dd className="mono inline text-[#3a4650]">{a.changes[k]!.join(", ")}</dd></div>)}
          {(Object.keys(a.permissions) as Array<keyof PermissionSnapshot>).filter((k) => (a.permissions[k] ?? []).length > 0).map((k) => <div key={k}><dt className="inline font-semibold">+ {PERMISSION_LABEL[k]}: </dt><dd className="mono inline text-[#3a4650]">{permissionText(a.permissions, k)}</dd></div>)}
        </dl>
        {a.decision && <p className="mt-2 text-xs text-[#64717c]">{a.decision.actor ?? "human"} at {formatTime(a.decision.at)}{a.decision.reason ? ` — ${a.decision.reason}` : ""}{a.status === "approved" && a.decision.deferred.length > 0 && ` · ${a.decision.deferred.map((k) => PERMISSION_LABEL[k]).join(", ")} take effect on the next run`}</p>}
        {a.status === "pending" && <div className="mt-3 flex gap-2">
          <ActionButton onClick={() => decide(approveAmendment, a.id, "Approved from workbench")}>Approve &amp; resume</ActionButton>
          <ActionButton variant="danger" onClick={() => { const reason = window.prompt("Why deny this request?", "Out of scope for this task"); if (reason === null) return; return decide(denyAmendment, a.id, reason); }}>Deny</ActionButton>
        </div>}
      </li>)}
    </ul>
  </Section>;
}

function permissionText(p: PermissionSnapshot, key: keyof PermissionSnapshot): string {
  if (key === "filesystem") return (p.filesystem ?? []).map((f) => `${f.path} (${f.access === "read_write" ? "rw" : "ro"})`).join(", ");
  if (key === "mcpServers") return (p.mcpServers ?? []).map((s) => (typeof s === "string" ? s : s.name)).join(", ");
  return (p[key] ?? []).join(", ");
}
