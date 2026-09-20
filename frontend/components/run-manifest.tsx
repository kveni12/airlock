"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { getRunManifestMarkdown, manifestDownloadUrl } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { ErrorBanner } from "./ui";

/** Read-only Run Manifest: the whole request → intent → permissions → behavior → result → decision chain in one document. */
export function RunManifestView({ runId }: { runId: string }) {
  const load = useCallback((signal: AbortSignal) => getRunManifestMarkdown(runId, signal), [runId]);
  const manifest = useResource(load);

  return <div className="mx-auto max-w-4xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link href={`/runs/${runId}`} className="inline-flex items-center gap-1 text-sm text-[#64717c] hover:underline"><ArrowLeft className="size-4" />Back to run</Link>
      <a href={manifestDownloadUrl(runId)} download={`${runId}-manifest.md`} className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f3f4f5]"><Download className="size-3.5" />Download .md</a>
    </div>
    {manifest.error && <ErrorBanner message={manifest.error} onRetry={manifest.refresh} />}
    {!manifest.data && !manifest.error && <div className="skeleton h-96" />}
    {manifest.data && <article className="card p-6"><pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-[#14212a]">{manifest.data}</pre></article>}
  </div>;
}
