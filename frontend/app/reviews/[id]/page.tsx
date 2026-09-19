import { notFound } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { ReviewWorkspace } from "../../../components/review-workspace";
import { getReviewTask } from "../../../lib/review-data";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = getReviewTask(id);
  if (!review) notFound();
  return <AppShell><ReviewWorkspace review={review} /></AppShell>;
}
