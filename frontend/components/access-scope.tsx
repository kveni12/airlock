"use client";

import { useState } from "react";
import { Eye, EyeOff, Globe, KeyRound, Plug, Wrench, X } from "lucide-react";
import type { PermissionSnapshot, RuntimeProviderKind } from "@/lib/contracts";

export type FolderAccess = "read" | "read_write";
export interface FolderGrant {
  path: string;
  access: FolderAccess;
}

/** The human-chosen access scope for a run. Least privilege by default: repo folder only, no internet, no secrets. */
export interface AccessScope {
  folders: FolderGrant[];
  hosts: string[];
  secrets: string[];
  mcpServers: string[];
  tools: string[];
}

export const DEFAULT_SCOPE: AccessScope = { folders: [{ path: "/workspace", access: "read_write" }], hosts: [], secrets: [], mcpServers: [], tools: ["filesystem", "shell"] };

export function scopeToPermissions(scope: AccessScope, mode: "planner" | "builder"): PermissionSnapshot {
  return {
    filesystem: scope.folders.map((f) => ({ path: normalizeFolder(f.path), access: mode === "planner" ? "read" : f.access })),
    network: scope.hosts,
    secrets: scope.secrets,
    mcpServers: scope.mcpServers,
    tools: scope.tools
  };
}

/** Folder paths are relative to the repo; "/workspace" is where the copy is mounted inside the sandbox. */
export function normalizeFolder(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed || trimmed === "." || trimmed === "/workspace") return "/workspace";
  if (trimmed.startsWith("/workspace/")) return trimmed;
  return `/workspace/${trimmed.replace(/^\.?\//, "")}`;
}

export function displayFolder(path: string): string {
  return path === "/workspace" ? "whole repo" : path.replace(/^\/workspace\//, "");
}

type Enforcement = { label: string; tone: "good" | "warn" | "neutral"; detail: string };

function folderEnforcement(provider: RuntimeProviderKind): Enforcement {
  if (provider === "process") return { tone: "warn", label: "not isolated", detail: "process runtime has no sandbox: the agent can read anything on this machine. Writes outside the allowed folders are flagged in the workbench, not prevented." };
  return { tone: "good", label: "repo only", detail: "Only a temporary copy of this repo is mounted in the sandbox — the rest of your machine is not visible. Writes outside the folders you allow are flagged in the workbench; reads inside the repo cannot be traced." };
}

const NETWORK_ENFORCEMENT: Enforcement = { tone: "good", label: "blocked", detail: "Hosts not on this list are refused by the Periscope proxy (HTTP/HTTPS via proxy env). Direct sockets that bypass the proxy cannot be observed." };
const SECRET_ENFORCEMENT: Enforcement = { tone: "good", label: "not injected", detail: "Only the named environment variables are copied into the sandbox from the backend process; anything else is simply absent." };
const MCP_ENFORCEMENT: Enforcement = { tone: "neutral", label: "agent-reported", detail: "MCP usage is known only from the agent's own output. A server not listed here is flagged if the agent reports using it." };
const TOOL_ENFORCEMENT: Enforcement = { tone: "neutral", label: "agent-reported", detail: "Tool use is known from the agent's output and process telemetry; unlisted tools are flagged, not prevented." };

function EnforcementTag({ e }: { e: Enforcement }) {
  const cls = e.tone === "good" ? "status-good" : e.tone === "warn" ? "status-warn" : "status-info";
  return <span className={`status ${cls}`} title={e.detail}>{e.label}</span>;
}

function TagList({ items, onRemove, empty }: { items: string[]; onRemove: (item: string) => void; empty: string }) {
  if (!items.length) return <p className="text-sm text-[#64717c]">{empty}</p>;
  return <ul className="flex flex-wrap gap-1.5">{items.map((item) => <li key={item} className="mono inline-flex items-center gap-1 rounded-md border bg-white px-2 py-1 text-xs"><span>{item}</span><button type="button" onClick={() => onRemove(item)} aria-label={`Remove ${item}`} className="text-[#64717c] hover:text-[#9a3d31]"><X className="size-3" /></button></li>)}</ul>;
}

function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  const commit = () => { const v = value.trim(); if (v) { onAdd(v); setValue(""); } };
  return <div className="mt-2 flex gap-2">
    <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} placeholder={placeholder} className="mono w-full rounded-lg border bg-white px-3 py-1.5 text-xs" />
    <button type="button" onClick={commit} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold hover:bg-[#f0f2f3]">Add</button>
  </div>;
}

export function summarizeScope(scope: AccessScope, provider: RuntimeProviderKind): string[] {
  const rw = scope.folders.filter((f) => f.access === "read_write").map((f) => displayFolder(f.path));
  const ro = scope.folders.filter((f) => f.access === "read").map((f) => displayFolder(f.path));
  const out: string[] = [];
  out.push(provider === "process" ? "Can see: this machine (process runtime is not isolated)." : "Can see: a temporary copy of this repo, nothing else on your machine.");
  out.push(rw.length ? `Can change: ${rw.join(", ")}.` : "Can change: nothing (read-only run).");
  if (ro.length) out.push(`Read only: ${ro.join(", ")}.`);
  out.push(scope.hosts.length ? `Internet: only ${scope.hosts.join(", ")}.` : "Internet: off.");
  out.push(scope.secrets.length ? `Secrets: ${scope.secrets.join(", ")}.` : "Secrets: none.");
  out.push(scope.mcpServers.length ? `MCP servers: ${scope.mcpServers.join(", ")}.` : "MCP servers: none.");
  out.push("If the plan needs more than this, Periscope will ask you before the run starts.");
  return out;
}

export function AccessScopeEditor({ scope, onChange, provider, plannerOnly }: { scope: AccessScope; onChange: (scope: AccessScope) => void; provider: RuntimeProviderKind; plannerOnly?: boolean }) {
  const set = (patch: Partial<AccessScope>) => onChange({ ...scope, ...patch });
  const addFolder = (path: string) => {
    const normalized = normalizeFolder(path);
    if (scope.folders.some((f) => f.path === normalized)) return;
    set({ folders: [...scope.folders, { path: normalized, access: "read_write" }] });
  };
  const addUnique = (key: "hosts" | "secrets" | "mcpServers" | "tools") => (value: string) => { if (!scope[key].includes(value)) set({ [key]: [...scope[key], value] }); };
  const remove = (key: "hosts" | "secrets" | "mcpServers" | "tools") => (value: string) => set({ [key]: scope[key].filter((v) => v !== value) });
  const folderE = folderEnforcement(provider);
  const block = "rounded-xl border bg-white p-3";
  const head = "flex flex-wrap items-center justify-between gap-2";
  const title = "flex items-center gap-1.5 text-sm font-semibold";

  return <div className="space-y-3 rounded-xl border bg-[#f6f2ec] p-4">
    <div>
      <p className="text-sm font-semibold">What the agent can access</p>
      <p className="mt-1 text-xs text-[#64717c]">Start small. Each label says whether Periscope <em>prevents</em> access outside the scope or can only <em>flag</em> it afterwards.{plannerOnly && " The planner always runs read-only regardless of the folder settings below."}</p>
    </div>

    <div className={block}>
      <div className={head}><p className={title}><Eye className="size-4" />Folders</p><EnforcementTag e={folderE} /></div>
      <p className="mt-1 text-xs text-[#64717c]">{folderE.detail}</p>
      <ul className="mt-2 space-y-1.5">{scope.folders.map((f) => <li key={f.path} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mono flex-1 truncate">{displayFolder(f.path)}</span>
        <select value={f.access} onChange={(e) => set({ folders: scope.folders.map((g) => g.path === f.path ? { ...g, access: e.target.value as FolderAccess } : g) })} className="rounded-lg border bg-white px-2 py-1 text-xs">
          <option value="read_write">can change</option>
          <option value="read">read only</option>
        </select>
        <button type="button" disabled={scope.folders.length === 1} onClick={() => set({ folders: scope.folders.filter((g) => g.path !== f.path) })} aria-label={`Remove ${f.path}`} className="text-[#64717c] hover:text-[#9a3d31] disabled:opacity-30"><X className="size-3.5" /></button>
      </li>)}</ul>
      <AddInput placeholder="add a folder, e.g. src/auth or tests" onAdd={addFolder} />
      {scope.folders.some((f) => f.path === "/workspace" && f.access === "read_write") && scope.folders.length > 1 && <p className="mt-1 text-xs text-[#815017]"><EyeOff className="mr-1 inline size-3" />&quot;whole repo · can change&quot; makes the other folder rules redundant — set it to read only to actually narrow the scope.</p>}
    </div>

    <div className="grid gap-3 md:grid-cols-2">
      <div className={block}>
        <div className={head}><p className={title}><Globe className="size-4" />Internet</p><EnforcementTag e={NETWORK_ENFORCEMENT} /></div>
        <p className="mt-1 text-xs text-[#64717c]">{scope.hosts.length ? "Only these hosts (and their subdomains) are reachable." : "Off — every outbound request through the proxy is refused."}</p>
        <div className="mt-2"><TagList items={scope.hosts} onRemove={remove("hosts")} empty="No hosts allowed." /></div>
        <AddInput placeholder="registry.npmjs.org" onAdd={addUnique("hosts")} />
      </div>
      <div className={block}>
        <div className={head}><p className={title}><KeyRound className="size-4" />Secrets</p><EnforcementTag e={SECRET_ENFORCEMENT} /></div>
        <p className="mt-1 text-xs text-[#64717c]">Env var names read from the backend process; values are never stored or shown.</p>
        <div className="mt-2"><TagList items={scope.secrets} onRemove={remove("secrets")} empty="No secrets injected." /></div>
        <AddInput placeholder="ANTHROPIC_API_KEY" onAdd={addUnique("secrets")} />
      </div>
      <div className={block}>
        <div className={head}><p className={title}><Plug className="size-4" />MCP servers</p><EnforcementTag e={MCP_ENFORCEMENT} /></div>
        <div className="mt-2"><TagList items={scope.mcpServers} onRemove={remove("mcpServers")} empty="None declared." /></div>
        <AddInput placeholder="github" onAdd={addUnique("mcpServers")} />
      </div>
      <div className={block}>
        <div className={head}><p className={title}><Wrench className="size-4" />Tools</p><EnforcementTag e={TOOL_ENFORCEMENT} /></div>
        <div className="mt-2"><TagList items={scope.tools} onRemove={remove("tools")} empty="Any tool (nothing to compare against)." /></div>
        <AddInput placeholder="browser" onAdd={addUnique("tools")} />
      </div>
    </div>

    <ul className="space-y-0.5 rounded-xl border border-dashed bg-white p-3 text-sm">{summarizeScope(scope, provider).map((line) => <li key={line}>{line}</li>)}</ul>
  </div>;
}
