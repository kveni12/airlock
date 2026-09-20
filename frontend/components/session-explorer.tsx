"use client";
import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { getRunTree, type RunTreeEntry } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const labels = { none: "No access", read: "Read only", read_write: "Can edit" };
export function SessionExplorer({ runId, changed, selected, onSelect, dir = "", depth = 0 }: { runId: string; changed: Set<string>; selected: string | null; onSelect: (file: RunTreeEntry) => void; dir?: string; depth?: number }) {
  const loader = useCallback((signal: AbortSignal) => getRunTree(runId, dir, signal), [runId, dir]);
  const tree = useResource(loader, 5000);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!tree.data && tree.error) return <p className="p-3 text-xs text-[#64717c]">{tree.error}</p>;
  if (!tree.data) return <p className="p-3 text-xs text-[#64717c]">Loading files…</p>;
  return <ul>{tree.data.entries.map((entry) => <li key={entry.path}>
    <button onClick={() => entry.kind === "dir" ? setOpen((prev) => { const next = new Set(prev); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; }) : onSelect(entry)} style={{ paddingLeft: 12 + depth * 12 }} className={`flex w-full items-center gap-1.5 py-2 pr-3 text-left text-xs hover:bg-[#eee9e2] ${selected === entry.path ? "bg-[#e8dfd3]" : ""}`}>
      {entry.kind === "dir" ? <>{open.has(entry.path) ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}<Folder className="size-3.5 shrink-0" /></> : <FileText className="size-3.5 shrink-0" />}
      <span className="truncate" title={entry.path}>{entry.name}</span>
      {changed.has(entry.path) && <span title="The agent reported a successful edit" className="text-[#14623f]">●</span>}
      <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${entry.access === "read_write" ? "bg-[#e5efe9] text-[#14623f]" : entry.access === "none" ? "bg-[#fbe5e0] text-[#9a3d31]" : "text-[#64717c]"}`}>{labels[entry.access]}</span>
    </button>
    {entry.kind === "dir" && open.has(entry.path) && <SessionExplorer runId={runId} changed={changed} selected={selected} onSelect={onSelect} dir={entry.path} depth={depth + 1} />}
  </li>)}{!tree.data.entries.length && <li className="p-3 text-xs text-[#64717c]">Empty folder</li>}</ul>;
}
