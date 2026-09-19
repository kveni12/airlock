import { AppShell } from "../../../components/app-shell";
import { ReviewWorkspace } from "../../../components/review-workspace";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell><ReviewWorkspace reviewId={id} /></AppShell>;
}
