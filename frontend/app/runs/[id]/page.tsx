import { AppShell } from "../../../components/app-shell";
import { RunDetail } from "../../../components/run-detail";

const tabs = ["chain", "findings", "timeline"] as const;

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const initialTab = tabs.find((item) => item === tab);
  return <AppShell><RunDetail runId={id} initialTab={initialTab} /></AppShell>;
}
