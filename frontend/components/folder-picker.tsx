"use client";

import { useCallback, useEffect, useState } from "react";
import { getHostFolders, pickHostFolder } from "@/lib/api";
import type { HostFolderListing } from "@/lib/contracts";

const inputCls = "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm";
const labelCls = "text-xs font-semibold uppercase tracking-wider text-[#64717c]";
const btnCls = "rounded-lg border bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f3f3f0] disabled:opacity-60";

/** Repo path input with an "Open folder…" browser over the backend machine's disk (native dialog when the backend can show one). */
export function RepoPathField({ value, onChange, mono = true }: { value: string; onChange: (path: string) => void; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div>
    <span className={labelCls}>Repo folder (on the machine running the backend)</span>
    <div className="mt-1 flex gap-2">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="/Users/you/code/my-app" className={`${inputCls} mt-0 flex-1 ${mono ? "mono" : ""}`} />
      <button type="button" onClick={() => setOpen(true)} className={btnCls}>Open folder…</button>
    </div>
    {open ? <FolderBrowser start={value} onCancel={() => setOpen(false)} onPick={(p) => { onChange(p); setOpen(false); }} /> : null}
  </div>;
}

function FolderBrowser({ start, onPick, onCancel }: { start: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<HostFolderListing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (dir?: string) => {
    setError("");
    try {
      setListing(await getHostFolders(dir));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (dir) {
        setError(message);
        try { setListing(await getHostFolders()); } catch { /* keep the first error */ }
      } else {
        setError(message);
      }
    }
  }, []);

  useEffect(() => {
    void load(start.startsWith("/") ? start : undefined);
  }, [load, start]);

  const native = async () => {
    setBusy(true);
    setError("");
    try {
      const chosen = await pickHostFolder(listing?.dir);
      if (chosen) onPick(chosen);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onCancel}>
    <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Open a folder</h2>
        {listing?.nativeDialog ? <button type="button" onClick={native} disabled={busy} className={btnCls}>{busy ? "Waiting for dialog…" : "Use system dialog"}</button> : null}
      </div>
      <p className="mt-1 text-xs text-[#64717c]">Folders on the machine running the Periscope backend. Git repositories are marked.</p>
      {listing ? <>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <button type="button" onClick={() => void load(listing.home)} className="rounded border px-2 py-1 text-xs">Home</button>
          <button type="button" onClick={() => listing.parent && void load(listing.parent)} disabled={!listing.parent} className="rounded border px-2 py-1 text-xs disabled:opacity-40">Up</button>
          <span className="mono truncate text-xs text-[#64717c]" title={listing.dir}>{listing.dir}</span>
        </div>
        <ul className="mt-2 max-h-72 divide-y overflow-auto rounded-lg border">
          {listing.entries.length === 0 ? <li className="px-3 py-2 text-sm text-[#64717c]">No sub-folders.</li> : null}
          {listing.entries.map((entry) => <li key={entry.path} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
            <button type="button" onClick={() => void load(entry.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline">
              <span aria-hidden>📁</span><span className="truncate">{entry.name}</span>
              {entry.isGitRepo ? <span className="rounded bg-[#e8f1ec] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#2f6b45]">git</span> : null}
            </button>
            {entry.isGitRepo ? <button type="button" onClick={() => onPick(entry.path)} className="rounded border px-2 py-0.5 text-xs font-semibold">Open</button> : null}
          </li>)}
        </ul>
      </> : !error ? <p className="mt-3 text-sm text-[#64717c]">Loading…</p> : null}
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button type="button" onClick={onCancel} className={btnCls}>Cancel</button>
        <button type="button" onClick={() => listing && onPick(listing.dir)} disabled={!listing} className="rounded-lg bg-[#182a33] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
          Use this folder{listing && !listing.isGitRepo ? " (not a git repo)" : ""}
        </button>
      </div>
    </div>
  </div>;
}
