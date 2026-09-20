"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Finding, ResolutionAttempt } from "@/lib/contracts";
import { classificationLabel, groupFindings, typeLabel } from "@/lib/findings";
import { FindingCard } from "./finding-card";
import { SeverityBadge } from "./ui";

/** One row per affected file/resource; expand to see each underlying finding with its evidence and actions. */
export function FindingGroups({ findings, resolutions = [], onChanged, showRun }: { findings: Finding[]; resolutions?: ResolutionAttempt[]; onChanged: () => Promise<void> | void; showRun?: boolean }) {
  const groups = groupFindings(findings);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return <div className="grid gap-3">
    {groups.map((group) => {
      const open = expanded[group.key] ?? group.open > 0;
      return <div key={group.key} className={`card overflow-hidden ${group.violatesRequest ? "border-[#c96b60]" : ""}`}>
        <button onClick={() => setExpanded((prev) => ({ ...prev, [group.key]: !open }))} className="flex w-full flex-wrap items-center gap-2 p-4 text-left hover:bg-[#f9f7f3]">
          {open ? <ChevronDown className="size-4 text-[#64717c]" /> : <ChevronRight className="size-4 text-[#64717c]" />}
          <SeverityBadge severity={group.severity} />
          {group.violatesRequest && <span className="status status-violation">violates human request</span>}
          <span className="mono text-sm font-semibold">{group.resource}</span>
          <span className="flex flex-wrap gap-1.5">{group.tags.map((tag) => <span key={tag} className={`status ${tag === "constraint_violation" ? "status-bad" : tag === "permission" ? "status-warn" : "status-muted"}`}>{typeLabel[tag] ?? tag}</span>)}</span>
          <span className="ml-auto text-xs text-[#64717c]">{group.findings.length} finding{group.findings.length === 1 ? "" : "s"}{group.open ? ` · ${group.open} open` : " · all handled"}{group.classifications.length ? ` · ${group.classifications.map((c) => classificationLabel[c]).join(", ")}` : ""}</span>
        </button>
        {open && <div className="grid gap-3 border-t bg-[#f9f7f3] p-3">
          {group.findings.map((finding) => <FindingCard key={finding.id} finding={finding} resolutions={resolutions.filter((r) => r.findingId === finding.id)} onChanged={onChanged} showRun={showRun} />)}
        </div>}
      </div>;
    })}
  </div>;
}
