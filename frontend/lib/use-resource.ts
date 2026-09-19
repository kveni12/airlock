"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polls a loader on an interval. The loader is read through a ref, so an inline arrow is fine:
 * pass `deps` (like a useEffect dependency list) for the values it closes over, e.g. `[runId]`.
 */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, refreshMs = 4000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await loaderRef.current(signal ?? new AbortController().signal);
      if (signal?.aborted) return;
      setData(next);
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
    setLoading(true);
    void refresh(controller.signal);
    const timer = refreshMs > 0 ? window.setInterval(() => void refresh(controller.signal), refreshMs) : undefined;
    return () => {
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshMs, ...deps]);

  return { data, loading, error, refresh: () => refresh() };
}
