"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, Globe, KeyRound, Plug, Wrench } from "lucide-react";
import type { AgentIntent, ObservedBehavior, PermissionSnapshot } from "@/lib/contracts";

export type FileMark = "declared" | "undeclared" | "expected_untouched";
type Access = "read" | "read_write";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

const WORKSPACE = "/workspace";

function rel(path: string): string {
  const p = path.replace(/^\.\//, "");
  if (p === WORKSPACE) return "";
  return p.startsWith(`${WORKSPACE}/`) ? p.slice(WORKSPACE.length + 1) : p.replace(/^\/+/, "");
}

/** Most specific grant wins; no grant at all means read-only workspace. */
export function effectiveAccess(grants: Map<string, Access>, path: string): { access: Access; from: string; explicit: boolean } {
  let best: { access: Access; from: string } = { access: grants.get("") ?? "read", from: "" };
  let bestLen = -1;
  for (const [g, access] of grants) {
    if (g === "" || path === g || path.startsWith(`${g}/`)) {
      const len = g === "" ? 0 : g.length;
      if (len > bestLen) { bestLen = len; best = { access, from: g }; }
    }
  }
  return { ...best, explicit: grants.has(path) };
}

function buildNodes(files: Iterable<string>, dirs: Iterable<string>): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const insert = (full: string, dir: boolean) => {
    const parts = full.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name: part, path, dir: i < parts.length - 1 || dir, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  };
  for (const d of dirs) if (d) insert(d, true);
  for (const f of files) insert(f, false);
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(!a.dir) - Number(!b.dir) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

export function fileMarks(changed: string[], intent?: AgentIntent): Map<string, FileMark> {
  const declared = (intent?.expectedFiles ?? []).map((f) => f.replace(/^\.\//, ""));
  const matches = (name: string) => declared.some((p) => p === name || (p.endsWith("/**") && name.startsWith(p.slice(0, -3) + "/")) || (p.endsWith("/*") && name.startsWith(p.slice(0, -2) + "/") && !name.slice(p.length - 1).includes("/")));
  const marks = new Map<string, FileMark>();
  for (const file of changed) marks.set(file, intent ? (matches(file) ? "declared" : "undeclared") : "declared");
  for (const file of declared) if (!file.includes("*") && !marks.has(file)) marks.set(file, "expected_untouched");
  return marks;
}

const dot: Record<FileMark, string> = { declared: "text-[#14623f]", undeclared: "text-[#815017]", expected_untouched: "text-[#98a4ad]" };

function AccessTag({ access, explicit, violated }: { access: Access; explicit?: boolean; violated?: boolean }) {
  if (violated) return <span title="Changed although only read access was granted" className="ml-auto shrink-0 rounded px-1 text-[9px] font-semibold uppercase bg-[#fff1ee] text-[#8c2f26]">wrote·R</span>;
  const rw = access === "read_write";
  return <span title={`${rw ? "Can change" : "Read only"}${explicit ? " (set here)" : " (inherited)"}`} className={`ml-auto rounded px-1 text-[9px] font-semibold uppercase ${rw ? "bg-[#effaf3] text-[#14623f]" : "bg-[#f0f2f3] text-[#64717c]"} ${explicit ? "" : "opacity-60"}`}>{rw ? "RW" : "R"}</span>;
}

function Row({ node, depth, grants, marks, selected, onSelect }: { node: Node; depth: number; grants: Map<string, Access>; marks: Map<string, FileMark>; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${6 + depth * 12}px` };
  const eff = effectiveAccess(grants, node.path);
  if (node.dir) {
    return <li>
      <button onClick={() => setOpen(!open)} style={pad} className="flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[11px] text-[#3a4650] hover:bg-[#edf0f2]">
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <FolderOpen className={`size-3 shrink-0 ${eff.access === "read_write" ? "text-[#14623f]" : "text-[#98a4ad]"}`} />
        <span className="truncate">{node.name}</span>
        <AccessTag access={eff.access} explicit={eff.explicit} />
      </button>
      {open && <ul>{node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} grants={grants} marks={marks} selected={selected} onSelect={onSelect} />)}</ul>}
    </li>;
  }
  const mark = marks.get(node.path);
  const untouched = mark === "expected_untouched";
  const violated = mark !== undefined && !untouched && eff.access === "read";
  return <li>
    <button onClick={() => onSelect(node.path)} style={pad} disabled={untouched || !mark} title={untouched ? "Declared in intent, no change observed" : mark === "undeclared" ? "Changed, not declared in intent" : mark === "declared" ? "Changed, declared in intent" : undefined}
      className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[11px] ${selected === node.path ? "bg-[#d1b191] text-[#182a33]" : untouched ? "text-[#98a4ad]" : "text-[#182a33] hover:bg-[#edf0f2]"}`}>
      <span className="inline-block w-3 shrink-0" />
      <span className={`text-[8px] ${mark ? dot[mark] : "text-transparent"}`}>{untouched ? "○" : "●"}</span>
      <span className="truncate">{node.name}</span>
      <AccessTag access={eff.access} explicit={eff.explicit} violated={violated} />
    </button>
  </li>;
}

function Group({ icon: Icon, title, summary, tone, children, defaultOpen = true }: { icon: typeof Globe; title: string; summary: string; tone: "good" | "muted" | "warn" | "bad"; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className="border-t">
    <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[#64717c] hover:bg-[#edf0f2]">
      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<Icon className="size-3" />{title}
      <span className={`status status-${tone} ml-auto !px-1.5 !py-0 !text-[9px] normal-case tracking-normal`}>{summary}</span>
    </button>
    {open && <div className="px-3 pb-2">{children}</div>}
  </div>;
}

function Item({ name, state, detail }: { name: string; state: "allowed" | "used" | "blocked" | "unlisted"; detail?: string }) {
  const cls = state === "used" ? "status-good" : state === "blocked" ? "status-bad" : state === "unlisted" ? "status-warn" : "status-muted";
  const label = state === "used" ? "used" : state === "blocked" ? "blocked" : state === "unlisted" ? "used · not granted" : "granted";
  return <li className="flex items-center gap-2 py-[2px] text-[11px]"><span className="mono truncate">{name}</span>{detail && <span className="truncate text-[10px] text-[#98a4ad]">{detail}</span>}<span className={`status ${cls} ml-auto !px-1.5 !py-0 !text-[9px]`}>{label}</span></li>;
}

function Empty({ text }: { text: string }) { return <p className="py-1 text-[11px] text-[#98a4ad]">{text}</p>; }

interface Props {
  permissions?: PermissionSnapshot;
  behavior?: ObservedBehavior;
  intent?: AgentIntent;
  changedFiles: string[];
  emptyFilesText: string;
  selected: string | null;
  onSelect: (path: string) => void;
}

/** Left-pane explorer: what the agent was allowed to touch (files, internet, secrets, MCP, tools) next to what was actually observed. */
export function AccessExplorer({ permissions, behavior, intent, changedFiles, emptyFilesText, selected, onSelect }: Props) {
  const grants = useMemo(() => {
    const g = new Map<string, Access>();
    for (const p of permissions?.filesystem ?? []) g.set(rel(p.path), p.access);
    return g;
  }, [permissions]);
  const marks = useMemo(() => fileMarks(changedFiles, intent), [changedFiles, intent]);
  const nodes = useMemo(() => buildNodes(marks.keys(), [...grants.keys()]), [marks, grants]);
  const undeclared = [...marks.values()].filter((m) => m === "undeclared").length;
  const violations = [...marks.entries()].filter(([p, m]) => m !== "expected_untouched" && effectiveAccess(grants, p).access === "read").length;
  const rootAccess = effectiveAccess(grants, "").access;

  const hosts = permissions?.network ?? [];
  const net = behavior?.networkDestinations ?? [];
  const blockedNet = net.filter((n) => n.allowed === false).length;
  const secrets = permissions?.secrets ?? [];
  const mcp = (permissions?.mcpServers ?? []).map((s) => typeof s === "string" ? s : s.name);
  const mcpCalls = behavior?.mcpCalls ?? [];
  const tools = permissions?.tools ?? [];
  const usedTools = behavior?.tools ?? [];
  const unlistedTools = usedTools.filter((t) => tools.length > 0 && !tools.includes(t.name));

  return <div className="text-[#182a33]">
    <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#64717c]">
      <span className="inline-flex items-center gap-1.5"><FolderOpen className="size-3" />Files</span>
      <span className="font-normal normal-case tracking-normal">{changedFiles.length} changed</span>
    </div>
    {(undeclared > 0 || violations > 0) && <p className="px-3 pb-1 text-[10px]">{undeclared > 0 && <span className="text-[#815017]">{undeclared} undeclared</span>}{undeclared > 0 && violations > 0 && <span className="text-[#98a4ad]"> · </span>}{violations > 0 && <span className="text-[#8c2f26]">{violations} written in read-only</span>}</p>}
    {nodes.length === 0 ? <p className="px-3 pb-2 text-[11px] text-[#98a4ad]">{emptyFilesText}</p>
      : <ul className="pb-1">{nodes.map((n) => <Row key={n.path} node={n} depth={0} grants={grants} marks={marks} selected={selected} onSelect={onSelect} />)}</ul>}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[10px] text-[#64717c]">
      <span title="Changed and declared in the intent"><span className="mr-1 text-[#14623f]">●</span>declared</span>
      <span title="Changed but not declared in the intent"><span className="mr-1 text-[#815017]">●</span>undeclared</span>
      <span title="Declared in the intent, no change observed"><span className="mr-1 text-[#98a4ad]">○</span>untouched</span>
      <span title="Only granted folders and observed changes are shown; the sandbox tree is not retained. Reads are not traced.">repo {rootAccess === "read_write" ? "RW" : "R"} · R/RW = granted</span>
    </div>

    <Group icon={Globe} title="Internet" tone={blockedNet ? "bad" : hosts.length ? "good" : "muted"} summary={hosts.length ? `${hosts.length} host${hosts.length === 1 ? "" : "s"}${blockedNet ? ` · ${blockedNet} blocked` : ""}` : blockedNet ? `off · ${blockedNet} blocked` : "off"}>
      <ul>
        {hosts.map((h) => <Item key={h} name={h} state={net.some((n) => n.name === h && n.allowed !== false) ? "used" : "allowed"} />)}
        {net.filter((n) => !hosts.includes(n.name)).map((n) => <Item key={n.name} name={n.name} state={n.allowed === false ? "blocked" : "unlisted"} />)}
      </ul>
      {hosts.length === 0 && net.length === 0 && <Empty text="No internet access granted; proxied traffic would be blocked and listed here." />}
    </Group>

    <Group icon={KeyRound} title="Secrets" tone={secrets.length ? "good" : "muted"} summary={secrets.length ? `${secrets.length} injected` : "none"}>
      {secrets.length ? <ul>{secrets.map((s) => <Item key={s} name={s} state="allowed" detail="injected · reads not traced" />)}</ul> : <Empty text="No secrets injected into the sandbox." />}
    </Group>

    <Group icon={Plug} title="MCP servers" tone={mcpCalls.some((c) => c.server && !mcp.includes(c.server)) ? "warn" : mcp.length ? "good" : "muted"} summary={mcp.length ? `${mcp.length} allowed${mcpCalls.length ? ` · ${mcpCalls.length} calls` : ""}` : mcpCalls.length ? `none · ${mcpCalls.length} calls` : "none"}>
      <ul>
        {mcp.map((s) => <Item key={s} name={s} state={mcpCalls.some((c) => c.server === s) ? "used" : "allowed"} detail={mcpCalls.filter((c) => c.server === s).map((c) => c.name).join(", ") || undefined} />)}
        {mcpCalls.filter((c) => c.server && !mcp.includes(c.server)).map((c) => <Item key={`${c.server}:${c.name}`} name={c.server ?? c.name} state="unlisted" detail={c.name} />)}
      </ul>
      {mcp.length === 0 && mcpCalls.length === 0 && <Empty text="No MCP servers exposed to the agent." />}
    </Group>

    <Group icon={Wrench} title="Tools" tone={unlistedTools.length ? "warn" : "muted"} summary={tools.length ? `${tools.length} allowed` : "any"} defaultOpen={false}>
      <ul>
        {tools.map((t) => <Item key={t} name={t} state={usedTools.some((u) => u.name === t) ? "used" : "allowed"} />)}
        {unlistedTools.map((t) => <Item key={t.name} name={t.name} state="unlisted" />)}
        {tools.length === 0 && usedTools.map((t) => <Item key={t.name} name={t.name} state="used" />)}
      </ul>
      {tools.length === 0 && usedTools.length === 0 && <Empty text="No tool restrictions; none reported yet." />}
      <p className="pt-1 text-[10px] text-[#98a4ad]">Tool use is agent-reported.</p>
    </Group>
  </div>;
}
