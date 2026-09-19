"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Polls a loader on an interval; `loader` must be stable (wrap in useCallback) or keyed via deps. */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, refreshMs = 4000) {
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
  }, [refresh, refreshMs, loader]);

  return { data, loading, error, refresh: () => refresh() };
}
