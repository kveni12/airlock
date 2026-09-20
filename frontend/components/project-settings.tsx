"use client";

import { localAgent } from "../../shared/local-agents.mjs";
import Link from "next/link";
import { useCallback, useState } from "react";
import { getProject, listRuns, updateProject } from "@/lib/api";
import type { Project } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { ProjectForm, toInput } from "./project-form";
import { ErrorBanner, RunStatusBadge, Section, formatTime } from "./ui";

export function ProjectSettings({ projectId }: { projectId: string }) {
  const loader = useCallback((signal: AbortSignal) => getProject(projectId, signal), [projectId]);
  const project = useResource<Project>(loader, 0);
  const loadRuns = useCallback(async (signal: AbortSignal) => (await listRuns(signal)).filter((run) => run.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [projectId]);
  const runs = useResource(loadRuns, 4000);
  const [saved, setSaved] = useState<string | null>(null);

  if (project.error) return <ErrorBanner message={project.error} onRetry={project.refresh} />;
  if (!project.data) return <p className="text-sm text-[#64717c]">Loading project…</p>;
  const p = project.data;

  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const agent = localAgent(p.agentKind === "claude_code" ? "claude_code" : "codex");
  const launch = `cd ${quote(p.repoPath)}\nperiscope ${agent.command} --project ${quote(p.id)}`;
  return <div className="space-y-4">
    <Section eyebrow="Local CLI" title={p.name}>
      <p className="text-sm text-[#64717c]">Run this in your terminal on the machine running Periscope. {agent.name} signs in with your {p.agentKind === "claude_code" ? "Claude" : "ChatGPT"} account. Allowed edits change this folder immediately.</p>
      {p.humanIntent && <p className="mt-3 rounded-lg bg-[#f6f2ec] p-3 text-sm"><strong>Task:</strong> {p.humanIntent}</p>}
      <pre className="mono my-3 overflow-x-auto rounded-lg bg-[#f6f2ec] p-3 text-sm">{launch}</pre>
      <p className="mb-3 text-sm text-[#64717c]">Sessions appear below automatically. Open a workbench to watch file and network activity, inspect permissions, or stop the agent.</p>
      {runs.error && <ErrorBanner message={runs.error} onRetry={runs.refresh} />}
      {!runs.data ? <p className="text-sm">Loading sessions…</p> : runs.data.length === 0 ? <p className="text-sm text-[#64717c]">No sessions for this project yet.</p> : <ul className="divide-y">
        {runs.data.map((run) => <li key={run.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <RunStatusBadge status={run.status} />
          <Link href={`/workbench/${run.id}`} className="mono underline">{run.agentId} · {run.id}</Link>
          <span className="text-[#64717c]">{formatTime(run.createdAt)} · {run.workspaceMode === "local" ? "Immediate local edits" : "Workspace copy"}</span>
          <Link href={`/workbench/${run.id}`} className="ml-auto rounded-lg border px-3 py-1.5">Open workbench →</Link>
        </li>)}
      </ul>}
    </Section>
    <details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer font-semibold">Edit task & permissions</summary><div className="mt-4"><Section eyebrow="Project settings" title={p.name} action={<div className="flex gap-2">
      <Link href="/projects" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-[#f6f2ec]">All projects</Link>

    </div>}>
      <p className="text-sm text-[#64717c]">Describe the task and choose the access for your next agent session. Changes apply to the next session. To change an active session’s filesystem access, stop it in the workbench, save these settings, then run the CLI again.</p>
      {saved && <p className="mt-2 text-xs text-[#1f6b3a]">{saved}</p>}
      <div className="mt-4">
        <ProjectForm key={p.updatedAt} initial={toInput(p)} submitLabel="Save settings" onSubmit={async (input) => { await updateProject(p.id, input); setSaved(`Saved ${new Date().toLocaleTimeString()}`); await project.refresh(); }} />
      </div>
    </Section></div></details>
  </div>;
}
