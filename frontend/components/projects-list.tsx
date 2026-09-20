"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FolderGit2, Plus } from "lucide-react";
import { createProject, deleteProject, getProjects, openProject } from "@/lib/api";
import type { Project } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { EMPTY_PROJECT, ProjectForm } from "./project-form";
import { ActionButton, Empty, ErrorBanner, Section, formatDateTime } from "./ui";

export const OPEN_PROJECT_KEY = "periscope.openProjectId";

export function ProjectsList({ initiallyCreating = false }: { initiallyCreating?: boolean }) {
  const router = useRouter();
  const projects = useResource<Project[]>((signal) => getProjects(signal), 10_000);
  const [creating, setCreating] = useState(initiallyCreating);

  const open = async (project: Project) => {
    await openProject(project.id);
    window.localStorage.setItem(OPEN_PROJECT_KEY, project.id);
    router.push(`/projects/${encodeURIComponent(project.id)}`);
  };

  const items = [...(projects.data ?? [])].sort((a, b) => (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt));

  return <div className="space-y-4">
    <Section eyebrow="Projects" title="Your projects" action={!creating && <ActionButton onClick={() => setCreating(true)}><Plus className="mr-1 inline size-4" />New project</ActionButton>}>
      <p className="text-sm text-[#64717c]">Choose a folder, describe the task, and review permissions. Then use the project’s CLI command in that folder and follow its session here.</p>
      {creating && <div className="mt-4 rounded-xl border bg-[#f6f2ec] p-4">
        <ProjectForm initial={EMPTY_PROJECT} submitLabel="Create project" onCancel={() => setCreating(false)} onSubmit={async (input) => { const created = await createProject(input); router.push(`/projects/${created.id}`); }} />
      </div>}
    </Section>
    {projects.error && <ErrorBanner message={projects.error} onRetry={projects.refresh} />}
    {!projects.loading && !items.length && !creating && <Empty title="No projects yet" body="Create a project to configure and track local agent sessions." action={<ActionButton onClick={() => setCreating(true)}>New project</ActionButton>} />}
    <ul className="grid gap-3 md:grid-cols-2">{items.map((project) => {
      const s = project.scope.folders.filter((f) => f.access === "read_write").map((f) => `Can edit: ${f.path.replace("/workspace/", "")}`);
      return <li key={project.id} className="card flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-base font-semibold"><FolderGit2 className="size-4 text-[#64717c]" />{project.name}</p>
            <p className="mono mt-1 truncate text-xs text-[#64717c]">{project.repoPath}{project.branch ? ` @ ${project.branch}` : ""}</p>
          </div>
          <span className="rounded-md border bg-[#e6e9eb]/60 px-2 py-0.5 text-xs">{project.runtime}{project.agentKind ? ` · ${project.agentKind}` : ""}</span>
        </div>
        <ul className="space-y-0.5 text-xs text-[#3d4a55]">{s.map((line) => <li key={line}>{line}</li>)}</ul>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <ActionButton onClick={() => open(project)}>Open project</ActionButton>
          <Link href={`/projects/${encodeURIComponent(project.id)}`} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-[#f6f2ec]">Settings</Link>
          <ActionButton variant="danger" confirm={`Delete project "${project.name}"? Runs already recorded are kept.`} onClick={async () => { await deleteProject(project.id); if (window.localStorage.getItem(OPEN_PROJECT_KEY) === project.id) window.localStorage.removeItem(OPEN_PROJECT_KEY); await projects.refresh(); }}>Delete</ActionButton>
          <span className="ml-auto text-xs text-[#64717c]">{project.lastOpenedAt ? `opened ${formatDateTime(project.lastOpenedAt)}` : `created ${formatDateTime(project.createdAt)}`}</span>
        </div>
      </li>;
    })}</ul>
  </div>;
}
