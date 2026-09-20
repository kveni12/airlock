"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { getProjects, listRuns } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Empty, ErrorBanner, RunStatusBadge, formatDateTime } from "./ui";

export function RunsList() {
  const loader = useCallback(async (signal: AbortSignal) => {
    const [runs, projects] = await Promise.all([listRuns(signal), getProjects(signal)]);
    return { runs, projects };
  }, []);
  const { data, loading, error, refresh } = useResource(loader);
  const [query, setQuery] = useState("");
  const projectName = (id?: string) => data?.projects.find((p) => p.id === id)?.name;
  const runs = [...(data?.runs ?? [])].filter((run) => `${projectName(run.projectId) ?? ""} ${run.agentId} ${run.id}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <section className="space-y-5">
    <div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold">Runs</h1><p className="mt-2 text-sm text-[#64717c]">Current and previous sessions across your projects.</p></div><Link href="/projects" className="rounded-lg border px-4 py-2 text-sm">Open a project</Link></div>
    {error && <ErrorBanner message={error} onRetry={refresh} />}
    <input aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search project or session" className="w-full rounded-lg border bg-white px-3 py-2 text-sm" />
    <ul className="space-y-3">{runs.map((run) => <li key={run.id} className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-center gap-3"><RunStatusBadge status={run.status} /><Link href={`/workbench/${run.id}`} className="font-semibold hover:underline">{projectName(run.projectId) ?? run.agentId}</Link><Link href={`/workbench/${run.id}`} className="ml-auto text-sm underline">Open session →</Link></div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#64717c]"><span>{formatDateTime(run.createdAt)}</span><span>{run.workspaceMode === "local" ? "Local edits" : "Workspace copy"}</span>{run.gitSummary && run.workspaceMode !== "local" && <span>{run.gitSummary.filesChanged} changed files</span>}{run.projectId && <Link href={`/projects/${run.projectId}`} className="underline">Project & permissions</Link>}</div>
    </li>)}</ul>
    {!loading && !runs.length && <Empty title="No sessions found" body="Create a project, then launch its agent using the command on the project page. Sessions will appear here automatically." action={<Link href="/projects" className="underline">Go to projects</Link>} />}
  </section>;
}
