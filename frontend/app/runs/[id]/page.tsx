import { AppShell } from "../../../components/app-shell";
import { RunDetail } from "../../../components/run-detail";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><RunDetail runId={id} /></AppShell>;
}
