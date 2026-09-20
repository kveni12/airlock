import { AppShell } from "../../../components/app-shell";
import { ProjectSettings } from "../../../components/project-settings";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><ProjectSettings projectId={id} /></AppShell>;
}
