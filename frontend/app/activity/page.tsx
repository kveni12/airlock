import { ActivityFeed } from "../../components/activity-feed";
import { AppShell } from "../../components/app-shell";
import type { EventCategory } from "../../lib/contracts";

const categories: EventCategory[] = ["agent", "filesystem", "process", "network", "secret", "mcp", "git", "policy", "runtime"];

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const initialFilter = categories.find((item) => item === category);
  return <AppShell><ActivityFeed initialFilter={initialFilter} /></AppShell>;
}
