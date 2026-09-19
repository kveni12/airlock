"use client";

import { useEffect, useState } from "react";
import { checkHealth } from "@/lib/api";

export function RuntimeIndicator() {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => checkHealth(controller.signal).then(setOnline).catch(() => setOnline(false));
    void check();
    const timer = window.setInterval(check, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return <div className="flex items-center gap-2 text-sm">
    <span className={`size-2 rounded-full ${online === null ? "bg-slate-400" : online ? "bg-emerald-500" : "bg-amber-500"}`} />
    <span className="hidden sm:inline">{online === null ? "Checking runtime" : online ? "Runtime online" : "Demo mode"}</span>
  </div>;
}
