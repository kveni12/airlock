import type { EventSeverity, Finding, FindingClassification } from "./contracts";

const SEVERITY_RANK: Record<EventSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export const classificationLabel: Record<FindingClassification, string> = {
  request_drift: "violates request",
  plan_drift: "plan drift",
  permission_violation: "permission violation"
};

export const typeLabel: Record<string, string> = {
  constraint_violation: "explicit rule broken",
  spec_drift: "not in plan",
  sensitive_change: "sensitive change",
  permission: "outside permissions",
  dependency: "dependency",
  network: "network",
  tests: "tests",
  code_quality: "code quality",
  security: "security",
  missing_action: "declared, not done",
  other: "other"
};

export interface FindingGroup {
  key: string;
  /** The file, dependency, host, tool or other thing the findings are about. */
  resource: string;
  findings: Finding[];
  severity: EventSeverity;
  /** Distinct type tags carried by the group, strongest first. */
  tags: string[];
  classifications: FindingClassification[];
  open: number;
  violatesRequest: boolean;
}

export function severityRank(severity: EventSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

export function findingResource(finding: Finding): string {
  return finding.file ?? finding.evidence?.observedResource ?? finding.title;
}

/** Collapse several findings about the same thing (e.g. infra/prod.tf as spec drift + sensitive change + policy violation) into one row. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.runId ?? ""}:${findingResource(finding).replace(/^\/workspace\//, "")}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.entries()]
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
      return {
        key,
        resource: findingResource(sorted[0]).replace(/^\/workspace\//, ""),
        findings: sorted,
        severity: sorted[0].severity,
        tags: [...new Set(sorted.map((f) => f.type))],
        classifications: [...new Set(sorted.map((f) => f.classification).filter((c): c is FindingClassification => Boolean(c)))],
        open: sorted.filter((f) => f.status === "open" || f.status === "resolving" || f.status === "re_reviewing").length,
        violatesRequest: sorted.some((f) => f.type === "constraint_violation" || f.classification === "request_drift")
      };
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.open - a.open);
}

/** Resources (files, dependencies, hosts) that break an explicit human constraint in this run. */
export function violatedResources(findings: Finding[]): Set<string> {
  return new Set(
    findings
      .filter((f) => f.type === "constraint_violation" && f.status !== "dismissed")
      .flatMap((f) => [f.file, f.evidence?.observedResource].filter((v): v is string => Boolean(v)))
  );
}
