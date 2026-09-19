"use client";

import { useCallback, useEffect, useState } from "react";
import { loadDashboardSnapshot } from "./api";
import type { DashboardSnapshot } from "./contracts";

export function useAgentGuardSnapshot(refreshMs = 5000) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await loadDashboardSnapshot(signal);
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), refreshMs);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh, refreshMs]);

  return { snapshot, loading, error, refresh: () => refresh() };
}
