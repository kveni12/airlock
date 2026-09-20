import { AppShell } from "../../../../components/app-shell";
import { RunManifestView } from "../../../../components/run-manifest";

export default async function RunManifestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><RunManifestView runId={id} /></AppShell>;
}
