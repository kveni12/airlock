"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { getProject, openProject, updateProject } from "@/lib/api";
import type { Project } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { ProjectForm, toInput } from "./project-form";
import { OPEN_PROJECT_KEY } from "./projects-list";
import { ActionButton, ErrorBanner, Section } from "./ui";

export function ProjectSettings({ projectId }: { projectId: string }) {
  const router = useRouter();
  const loader = useCallback((signal: AbortSignal) => getProject(projectId, signal), [projectId]);
  const project = useResource<Project>(loader, 0);
  const [saved, setSaved] = useState<string | null>(null);

  if (project.error) return <ErrorBanner message={project.error} onRetry={project.refresh} />;
  if (!project.data) return <p className="text-sm text-[#64717c]">Loading project…</p>;
  const p = project.data;

  return <div className="space-y-4">
    <Section eyebrow="Project settings" title={p.name} action={<div className="flex gap-2">
      <Link href="/projects" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-[#f6f2ec]">All projects</Link>
      <ActionButton onClick={async () => { await openProject(p.id); window.localStorage.setItem(OPEN_PROJECT_KEY, p.id); router.push(`/requests/new?project=${encodeURIComponent(p.id)}`); }}>Open → New request</ActionButton>
    </div>}>
      <p className="text-sm text-[#64717c]">These settings are saved with the project and pre-fill every new request for it. Changing them here never touches runs already recorded.</p>
      {saved && <p className="mt-2 text-xs text-[#1f6b3a]">{saved}</p>}
      <div className="mt-4">
        <ProjectForm key={p.updatedAt} initial={toInput(p)} submitLabel="Save settings" onSubmit={async (input) => { await updateProject(p.id, input); setSaved(`Saved ${new Date().toLocaleTimeString()}`); await project.refresh(); }} />
      </div>
    </Section>
  </div>;
}
