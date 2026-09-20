import { Suspense } from "react";
import { AppShell } from "../../../components/app-shell";
import { NewRequestFlow } from "../../../components/new-request-flow";

export default function NewRequestPage() {
  return <AppShell><Suspense fallback={null}><NewRequestFlow /></Suspense></AppShell>;
}
