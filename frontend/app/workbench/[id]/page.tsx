import { AppShell } from "../../../components/app-shell";
import { Workbench } from "../../../components/workbench";

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><Workbench runId={id} /></AppShell>;
}
