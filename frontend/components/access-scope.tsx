"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, FileCode2, FolderOpen, Globe, KeyRound, Pencil, Plug, RotateCcw, Wrench, X } from "lucide-react";
import { getRepoTree } from "@/lib/api";
import type { PermissionSnapshot, RepoTreeEntry, RuntimeProviderKind } from "@/lib/contracts";

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

export const DEFAULT_SCOPE: AccessScope = { folders: [{ path: "/workspace", access: "read" }], hosts: [], secrets: [], mcpServers: [], tools: ["filesystem", "shell"] };

/** Access that applies to a repo-relative path: the most specific grant wins, the whole-repo grant is the fallback. */
export function effectiveAccess(scope: AccessScope, relPath: string): { access: FolderAccess; from: string } {
  const target = normalizeFolder(relPath);
  let best: FolderGrant | undefined;
  for (const g of scope.folders) {
    if (target === g.path || target.startsWith(`${g.path}/`)) {
      if (!best || g.path.length > best.path.length) best = g;
    }
  }
  return best ? { access: best.access, from: best.path } : { access: "read", from: "/workspace" };
}

/** Sets access for a path, dropping the explicit grant when it merely repeats what the parent already gives. */
export function setFolderAccess(scope: AccessScope, relPath: string, access: FolderAccess): AccessScope {
  const target = normalizeFolder(relPath);
  const others = scope.folders.filter((g) => g.path !== target);
  const inherited = target === "/workspace" ? undefined : effectiveAccess({ ...scope, folders: others }, target).access;
  const folders = inherited === access ? others : [...others, { path: target, access }];
  return { ...scope, folders: folders.length ? folders : [{ path: "/workspace", access: "read" }] };
}

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
  if (!items.length) return <p className="text-sm text-[#657068]">{empty}</p>;
  return <ul className="flex flex-wrap gap-1.5">{items.map((item) => <li key={item} className="mono inline-flex items-center gap-1 rounded-md border bg-white px-2 py-1 text-xs"><span>{item}</span><button type="button" onClick={() => onRemove(item)} aria-label={`Remove ${item}`} className="text-[#657068] hover:text-[#9a3d31]"><X className="size-3" /></button></li>)}</ul>;
}

function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  const commit = () => { const v = value.trim(); if (v) { onAdd(v); setValue(""); } };
  return <div className="mt-2 flex gap-2">
    <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} placeholder={placeholder} className="mono w-full rounded-lg border bg-white px-3 py-1.5 text-xs" />
    <button type="button" onClick={commit} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold hover:bg-[#f1f4ee]">Add</button>
  </div>;
}

function AccessToggle({ value, onChange, inherited }: { value: FolderAccess; onChange: (access: FolderAccess) => void; inherited: boolean }) {
  const btn = (access: FolderAccess, label: string) => {
    const on = value === access;
    const tone = access === "read_write" ? "bg-[#fbe9c8] text-[#815017] border-[#e6c98f]" : "bg-[#e5efe9] text-[#14623f] border-[#b9d3c4]";
    return <button type="button" onClick={() => onChange(access)} aria-pressed={on} className={`px-2 py-0.5 text-[11px] font-semibold ${on ? `${tone} ${inherited ? "opacity-70" : ""}` : "bg-white text-[#9ca99d] hover:text-[#1b2620]"}`}>{label}</button>;
  };
  return <span className="inline-flex overflow-hidden rounded-md border text-xs">{btn("read", "read only")}{btn("read_write", "can change")}</span>;
}

function ExplorerRow({ entry, depth, scope, onChange, repoPath }: { entry: RepoTreeEntry; depth: number; scope: AccessScope; onChange: (scope: AccessScope) => void; repoPath: string }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<RepoTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eff = effectiveAccess(scope, entry.path);
  const explicit = eff.from === normalizeFolder(entry.path);

  useEffect(() => {
    if (!open || children || entry.kind !== "dir") return;
    const controller = new AbortController();
    getRepoTree(repoPath, entry.path, controller.signal).then((l) => setChildren(l.entries)).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open, children, entry, repoPath]);

  return <>
    <li className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-[#f1f4ee] ${explicit ? "bg-[#f7f9f4]" : ""}`} style={{ paddingLeft: `${depth * 16 + 4}px` }}>
      {entry.kind === "dir" ? <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"} className="text-[#657068]">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : <span className="inline-block size-3.5" />}
      {entry.kind === "dir" ? <FolderOpen className="size-3.5 text-[#657068]" /> : <FileCode2 className="size-3.5 text-[#9ca99d]" />}
      <span className="mono flex-1 truncate">{entry.name}</span>
      {explicit ? <span title="Set here"><Pencil className="size-3 text-[#657068]" /></span> : <span className="text-[10px] text-[#9ca99d]" title={`Inherited from ${displayFolder(eff.from)}`}>inherits</span>}
      <AccessToggle value={eff.access} inherited={!explicit} onChange={(a) => onChange(setFolderAccess(scope, entry.path, a))} />
      {explicit && <button type="button" onClick={() => onChange({ ...scope, folders: scope.folders.filter((g) => g.path !== normalizeFolder(entry.path)) })} title="Inherit from parent again" className="text-[#657068] hover:text-[#1b2620]"><RotateCcw className="size-3" /></button>}
    </li>
    {open && error && <li className="pl-8 text-xs text-[#9a3d31]">{error}</li>}
    {open && children?.map((c) => <ExplorerRow key={c.path} entry={c} depth={depth + 1} scope={scope} onChange={onChange} repoPath={repoPath} />)}
    {open && children?.length === 0 && <li className="text-xs text-[#9ca99d]" style={{ paddingLeft: `${depth * 16 + 40}px` }}>empty</li>}
  </>;
}

/** File-explorer view of the repo: click "read only" / "can change" on any folder or file; children inherit from the closest parent that was set. */
export function FolderExplorer({ repoPath, scope, onChange }: { repoPath: string; scope: AccessScope; onChange: (scope: AccessScope) => void }) {
  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((signal: AbortSignal) => {
    setError(null);
    setEntries(null);
    getRepoTree(repoPath, "", signal).then((l) => setEntries(l.entries)).catch((e: Error) => { if (!signal.aborted) setError(e.message); });
  }, [repoPath]);
  useEffect(() => { const c = new AbortController(); const t = setTimeout(() => load(c.signal), 250); return () => { clearTimeout(t); c.abort(); }; }, [load]);
  const root = effectiveAccess(scope, "/workspace");
  const overrides = scope.folders.filter((g) => g.path !== "/workspace");

  return <div className="mt-2 rounded-lg border bg-white">
    <ul className="max-h-72 overflow-auto p-1">
      <li className="flex items-center gap-1.5 rounded bg-[#f7f9f4] px-1 py-1 text-sm">
        <span className="inline-block size-3.5" /><FolderOpen className="size-3.5 text-[#657068]" />
        <span className="flex-1 truncate font-semibold">whole repo <span className="mono font-normal text-[#657068]">{repoPath}</span></span>
        <AccessToggle value={root.access} inherited={false} onChange={(a) => onChange(setFolderAccess(scope, "/workspace", a))} />
      </li>
      {error && <li className="px-2 py-1 text-xs text-[#9a3d31]">Could not list this repo path from the backend ({error}). You can still type folders below.</li>}
      {!error && entries === null && <li className="px-2 py-1 text-xs text-[#9ca99d]">Loading…</li>}
      {entries?.map((e) => <ExplorerRow key={e.path} entry={e} depth={1} scope={scope} onChange={onChange} repoPath={repoPath} />)}
    </ul>
    {overrides.length > 0 && <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5 text-xs text-[#657068]"><Pencil className="size-3" />Set here:{overrides.map((g) => <span key={g.path} className={`mono rounded px-1.5 py-0.5 ${g.access === "read_write" ? "bg-[#fbe9c8] text-[#815017]" : "bg-[#e5efe9] text-[#14623f]"}`}>{displayFolder(g.path)} · {g.access === "read_write" ? "can change" : "read only"}</span>)}</div>}
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

export function AccessScopeEditor({ scope, onChange, provider, plannerOnly, repoPath }: { scope: AccessScope; onChange: (scope: AccessScope) => void; provider: RuntimeProviderKind; plannerOnly?: boolean; repoPath: string }) {
  const set = (patch: Partial<AccessScope>) => onChange({ ...scope, ...patch });
  const addFolder = (path: string) => onChange(setFolderAccess(scope, path, "read_write"));
  const addUnique = (key: "hosts" | "secrets" | "mcpServers" | "tools") => (value: string) => { if (!scope[key].includes(value)) set({ [key]: [...scope[key], value] }); };
  const remove = (key: "hosts" | "secrets" | "mcpServers" | "tools") => (value: string) => set({ [key]: scope[key].filter((v) => v !== value) });
  const folderE = folderEnforcement(provider);
  const block = "rounded-xl border bg-white p-3";
  const head = "flex flex-wrap items-center justify-between gap-2";
  const title = "flex items-center gap-1.5 text-sm font-semibold";

  return <div className="space-y-3 rounded-xl border bg-[#f7f9f4] p-4">
    <div>
      <p className="text-sm font-semibold">What the agent can access</p>
      <p className="mt-1 text-xs text-[#657068]">Start small. Each label says whether Periscope <em>prevents</em> access outside the scope or can only <em>flag</em> it afterwards.{plannerOnly && " The planner always runs read-only regardless of the folder settings below."}</p>
    </div>

    <div className={block}>
      <div className={head}><p className={title}><Eye className="size-4" />Folders</p><EnforcementTag e={folderE} /></div>
      <p className="mt-1 text-xs text-[#657068]">{folderE.detail} Everything starts <strong>read only</strong>; mark the folders the agent may change. Sub-folders inherit from the nearest parent you set.</p>
      <FolderExplorer repoPath={repoPath} scope={scope} onChange={onChange} />
      <AddInput placeholder="or type a folder to allow changes, e.g. src/auth" onAdd={addFolder} />
      {effectiveAccess(scope, "/workspace").access === "read_write" && <p className="mt-1 text-xs text-[#815017]"><EyeOff className="mr-1 inline size-3" />The whole repo is set to &quot;can change&quot; — that is the widest folder scope. Set it to read only and pick specific folders to actually narrow it.</p>}
    </div>

    <div className="grid gap-3 md:grid-cols-2">
      <div className={block}>
        <div className={head}><p className={title}><Globe className="size-4" />Internet</p><EnforcementTag e={NETWORK_ENFORCEMENT} /></div>
        <p className="mt-1 text-xs text-[#657068]">{scope.hosts.length ? "Only these hosts (and their subdomains) are reachable." : "Off — every outbound request through the proxy is refused."}</p>
        <div className="mt-2"><TagList items={scope.hosts} onRemove={remove("hosts")} empty="No hosts allowed." /></div>
        <AddInput placeholder="registry.npmjs.org" onAdd={addUnique("hosts")} />
      </div>
      <div className={block}>
        <div className={head}><p className={title}><KeyRound className="size-4" />Secrets</p><EnforcementTag e={SECRET_ENFORCEMENT} /></div>
        <p className="mt-1 text-xs text-[#657068]">Env var names read from the backend process; values are never stored or shown.</p>
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
