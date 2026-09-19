"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL, checkHealth } from "@/lib/api";

const host = API_BASE_URL.replace(/^https?:\/\//, "");

export function RuntimeIndicator() {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => checkHealth(controller.signal).then(setOnline).catch(() => setOnline(false));
    void check();
    const timer = window.setInterval(check, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  const label = online === null ? "Checking backend" : online ? "Backend online" : "Demo mode";
  const help = online === null
    ? `Contacting the Periscope backend at ${host}…`
    : online
      ? `Live data from the Periscope backend at ${host}. Everything you see is persisted there.`
      : `The backend at ${host} is unreachable, so pages show labeled sample data and actions are disabled. Start it with \`npm run dev:all\` (or point NEXT_PUBLIC_AGENTGUARD_API_URL at a running backend) to go live.`;
  return <div className="group relative flex items-center gap-2 text-sm" tabIndex={0} aria-label={help}>
    <span className={`size-2 rounded-full ${online === null ? "bg-slate-400" : online ? "bg-emerald-500" : "bg-amber-500"}`} />
    <span className="hidden cursor-help border-b border-dotted border-[#98a4ad] sm:inline">{label}</span>
    <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border bg-white p-3 text-xs leading-5 text-[#3b4a55] opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{help}</span>
  </div>;
}
