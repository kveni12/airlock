"use client";

import { Check, Eye, EyeOff, FolderOpen, Pencil } from "lucide-react";
import { displayFolder } from "./access-scope";
import type { PermissionSnapshot } from "@/lib/contracts";

type FileAccess = NonNullable<PermissionSnapshot["filesystem"]>[number]["access"];
type FilePermission = NonNullable<PermissionSnapshot["filesystem"]>[number];

const ACCESS = {
  none: { label: "No access", icon: EyeOff, active: "border-[#cbd2d7] bg-[#f0f2f3] text-[#58656f]" },
  read: { label: "Read only", icon: Eye, active: "border-[#b9d3c4] bg-[#e5efe9] text-[#14623f]" },
  read_write: { label: "Can change", icon: Pencil, active: "border-[#e6c98f] bg-[#fbe9c8] text-[#815017]" }
} satisfies Record<FileAccess, { label: string; icon: typeof Eye; active: string }>;

export function filePermissions(permissions: PermissionSnapshot, access: FileAccess): FilePermission[] {
  return (permissions.filesystem ?? []).filter((item) => item.access === access);
}

export function mcpServerLabels(permissions: PermissionSnapshot, includeStatus = false): string[] {
  return (permissions.mcpServers ?? []).map((server) => {
    if (typeof server === "string") return server;
    return includeStatus ? `${server.name} · ${server.status}` : server.name;
  });
}

export function CapabilityItems({ items, empty = "None", tone = "neutral", limit }: { items: string[]; empty?: string; tone?: FileAccess | "neutral"; limit?: number }) {
  if (!items.length) return <span className="text-xs text-[#98a4ad]">{empty}</span>;
  const shown = limit ? items.slice(0, limit) : items;
  const cls = tone === "neutral" ? "border-[#d7dcdf] bg-white text-[#3a4650]" : ACCESS[tone].active;
  return <div className="flex flex-wrap gap-1.5">
    {shown.map((item, index) => <span key={`${item}-${index}`} title={item} className={`mono inline-flex max-w-52 items-center rounded-md border px-2 py-1 text-[11px] ${cls}`}><span className="truncate">{item}</span></span>)}
    {limit && items.length > limit ? <span className="rounded-md border bg-white px-2 py-1 text-[11px] text-[#64717c]">+{items.length - limit} more</span> : null}
  </div>;
}

export function FileAccessItems({ permissions, access, limit }: { permissions: PermissionSnapshot; access: FileAccess; limit?: number }) {
  return <CapabilityItems items={filePermissions(permissions, access).map((item) => displayFolder(item.path))} empty="—" tone={access} limit={limit} />;
}

/** Read-only version of the three-state folder control used on New Request. */
export function FileAccessState({ value }: { value: FileAccess }) {
  return <span className="inline-flex overflow-hidden rounded-md border bg-white text-[11px] font-semibold">
    {(["none", "read", "read_write"] as const).map((access) => {
      const meta = ACCESS[access];
      const Icon = meta.icon;
      const selected = access === value;
      return <span key={access} className={`inline-flex items-center gap-1 border-r px-2 py-1 last:border-r-0 ${selected ? meta.active : "text-[#a4adb4]"}`} aria-current={selected ? "true" : undefined}>
        {selected ? <Check className="size-3" /> : <Icon className="size-3 opacity-50" />}{meta.label}
      </span>;
    })}
  </span>;
}

export function FileAccessTable({ permissions }: { permissions: PermissionSnapshot }) {
  const files = permissions.filesystem ?? [];
  return <div className="overflow-x-auto rounded-lg border bg-white">
    <table className="w-full min-w-[620px] border-collapse text-left">
      <thead className="bg-[#f0f2f3] text-[11px] uppercase tracking-[.08em] text-[#64717c]"><tr><th className="px-3 py-2 font-semibold">Folder</th><th className="px-3 py-2 font-semibold">Access</th></tr></thead>
      <tbody className="divide-y">
        {files.length ? files.map((item, index) => <tr key={`${item.path}-${index}`}>
          <td className="px-3 py-2.5"><span className="inline-flex items-center gap-2"><FolderOpen className="size-3.5 text-[#64717c]" /><span className="mono text-xs">{displayFolder(item.path)}</span></span></td>
          <td className="px-3 py-2.5"><FileAccessState value={item.access} /></td>
        </tr>) : <tr><td colSpan={2} className="px-3 py-5 text-sm text-[#64717c]">No folder access configured.</td></tr>}
      </tbody>
    </table>
  </div>;
}
