"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { getRuntimeSetupJob, getRuntimeStatus, startRuntimeSetup } from "@/lib/api";
import type { RuntimeProviderKind, RuntimeSetupJob, RuntimeStatus } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";

/** Shows whether the chosen sandbox runtime is ready on the backend machine and lets the user set it up from the browser. */
export function RuntimeStatusPanel({ provider, agentKind }: { provider: RuntimeProviderKind; agentKind?: string }) {
  const load = useCallback((signal: AbortSignal) => getRuntimeStatus(signal), []);
  const status = useResource<RuntimeStatus>(load, 15_000);
  const refreshRef = useRef(status.refresh);
  refreshRef.current = status.refresh;
  const [job, setJob] = useState<RuntimeSetupJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobId = job?.status === "running" ? job.id : null;

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      getRuntimeSetupJob(jobId, controller.signal)
        .then((next) => {
          setJob(next);
          if (next.status !== "running") void refreshRef.current();
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [jobId]);

  const s = status.data;
  const readiness = s ? describe(s, provider, agentKind) : null;

  if (provider === "process") return null;
  if (status.error) return <p className="text-xs text-[#9a3d31]">Could not check runtime status: {status.error}</p>;
  if (!s || !readiness) return <p className="text-xs text-[#657068]">Checking runtime…</p>;

  const setup = async () => {
    setError(null);
    try {
      setJob(await startRuntimeSetup(provider === "docker" ? { provider: "docker" } : { provider: "lima", agent: readiness.limaAgent }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = job?.status === "running";
  return <div className={`rounded-lg border p-3 text-xs ${readiness.ready ? "border-[#b9d3c4] bg-[#f3f8f5]" : "border-[#e6c98f] bg-[#fdf6e7]"}`}>
    <div className="flex flex-wrap items-center gap-2">
      {readiness.ready ? <CheckCircle2 className="size-4 text-[#14623f]" /> : <CircleAlert className="size-4 text-[#815017]" />}
      <span className="font-semibold">{readiness.title}</span>
      <span className="text-[#657068]">{readiness.detail}</span>
      {readiness.action && !running && <button type="button" onClick={setup} className="ml-auto rounded-md bg-[#dff869] px-2.5 py-1 font-semibold text-[#17200f] hover:bg-[#d3ee55]">{readiness.action}</button>}
      {running && <span className="ml-auto inline-flex items-center gap-1 text-[#657068]"><Loader2 className="size-3.5 animate-spin" /> running on the backend machine…</span>}
    </div>
    {error && <p className="mt-1 text-[#9a3d31]">{error}</p>}
    {job && <details open={running} className="mt-2">
      <summary className="cursor-pointer text-[#657068]">Setup log · {job.status}{job.exitCode != null ? ` (exit ${job.exitCode})` : ""}</summary>
      <pre className="mono mt-1 max-h-48 overflow-auto rounded bg-[#1b2620] p-2 text-[11px] leading-snug text-[#dfe7e0]">{job.log.slice(-200).join("\n") || "(no output yet)"}</pre>
    </details>}
  </div>;
}

function describe(s: RuntimeStatus, provider: RuntimeProviderKind, agentKind?: string): { ready: boolean; title: string; detail: string; action?: string; limaAgent?: string } {
  if (provider === "docker") {
    if (!s.docker.available) return { ready: false, title: "Docker not reachable", detail: `${s.docker.detail ?? ""} Start Docker Desktop / the docker daemon on the machine running the backend.` };
    if (!s.docker.imagePresent) return { ready: false, title: `Image ${s.docker.image} not built yet`, detail: "It will be built automatically on the first run (a few minutes), or build it now.", action: "Build image now" };
    return { ready: true, title: "Docker sandbox ready", detail: `Runs go in a disposable container from ${s.docker.image}.` };
  }
  if (provider === "lima") {
    if (!s.lima.available) return { ready: false, title: "Lima not installed", detail: `${s.lima.detail ?? ""} Install it on the backend machine (macOS: brew install lima), then come back.` };
    if (!s.lima.baseVmPresent) return { ready: false, title: `Base VM ${s.lima.baseVm} missing`, detail: "Creates a small Ubuntu VM with git/node/python; takes several minutes and downloads an image.", action: "Create base VM" };
    const agentVm = agentKind ? s.lima.agentVms[agentKind] : undefined;
    if (agentVm && !agentVm.present && agentVm.vm !== s.lima.baseVm) {
      return { ready: false, title: `Agent VM ${agentVm.vm} missing`, detail: `Clones the base VM and installs the ${agentKind} CLI inside it.`, action: "Set up agent VM", limaAgent: limaAgentArg(agentKind) };
    }
    return { ready: true, title: "Lima sandbox ready", detail: `Each run clones ${agentVm?.vm ?? s.lima.baseVm} into a throwaway VM.` };
  }
  return { ready: true, title: "process", detail: "" };
}

function limaAgentArg(kind?: string): string | undefined {
  if (kind === "claude_code") return "claude-code";
  if (kind === "codex" || kind === "cursor" || kind === "devin") return kind;
  return undefined;
}
