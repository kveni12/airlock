import { AppShell } from "@/components/app-shell";
import { AgentDetail } from "@/components/agent-detail";
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <AppShell><AgentDetail agentId={decodeURIComponent(id)} /></AppShell>; }
