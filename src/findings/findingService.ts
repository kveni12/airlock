import type { AgentEvent, EventSeverity, Finding, FindingSource, FindingStatus, FindingType } from "../types.js";
import { EventCollector } from "../events/eventCollector.js";
import { JsonStore } from "../store/jsonStore.js";
import { createId } from "../utils/id.js";

export interface FindingFilters {
  status?: FindingStatus;
  severity?: EventSeverity;
  runId?: string;
  taskId?: string;
  source?: FindingSource;
}

export type FindingDraft = Omit<Finding, "id" | "createdAt" | "status"> & { status?: FindingStatus };

export class FindingService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: JsonStore,
    events?: EventCollector
  ) {
    events?.subscribeAll((event) => {
      if (event.category !== "policy" || event.action !== "violation") return;
      this.queue = this.queue.then(() => this.fromPolicyEvent(event));
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async create(draft: FindingDraft): Promise<Finding> {
    const duplicate = (await this.store.listFindings()).find((finding) => sameFinding(finding, draft));
    if (duplicate) return duplicate;
    const finding: Finding = {
      ...draft,
      id: createId("finding"),
      status: draft.status ?? "open",
      createdAt: new Date().toISOString()
    };
    await this.store.createFinding(finding);
    return finding;
  }

  async list(filters: FindingFilters = {}): Promise<Finding[]> {
    return (await this.store.listFindings()).filter(
      (finding) =>
        (!filters.status || finding.status === filters.status) &&
        (!filters.severity || finding.severity === filters.severity) &&
        (!filters.runId || finding.runId === filters.runId) &&
        (!filters.taskId || finding.taskId === filters.taskId) &&
        (!filters.source || finding.source === filters.source)
    );
  }

  get(id: string): Promise<Finding | undefined> {
    return this.store.getFinding(id);
  }

  async dismiss(id: string, dismissal: { reason?: string; actor?: string }): Promise<Finding> {
    const finding = await this.require(id);
    if (finding.status === "resolved") throw new Error("Resolved findings cannot be dismissed");
    const updated = await this.store.updateFinding(id, {
      status: "dismissed",
      dismissedAt: new Date().toISOString(),
      dismissal
    });
    return updated as Finding;
  }

  async transition(id: string, status: FindingStatus, patch: Partial<Finding> = {}): Promise<Finding> {
    const finding = await this.require(id);
    const allowed: Record<FindingStatus, FindingStatus[]> = {
      open: ["resolving", "dismissed"],
      resolving: ["re_reviewing", "open"],
      re_reviewing: ["resolved", "open"],
      resolved: [],
      dismissed: ["open"]
    };
    if (!allowed[finding.status].includes(status)) {
      throw new Error(`Invalid finding transition: ${finding.status} -> ${status}`);
    }
    const updated = await this.store.updateFinding(id, {
      ...patch,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : finding.resolvedAt
    });
    return updated as Finding;
  }

  private async fromPolicyEvent(event: AgentEvent): Promise<void> {
    const rule = typeof event.metadata?.rule === "string" ? event.metadata.rule : "policy_violation";
    const mapping = policyFinding(rule);
    await this.create({
      taskId: event.taskId,
      runId: event.runId,
      source: "policy",
      type: mapping.type,
      severity: event.severity ?? "high",
      title: mapping.title,
      description:
        typeof event.metadata?.message === "string" ? event.metadata.message : "AgentGuard policy detected a violation.",
      file: mapping.fileBased ? event.resource?.replace(/^\/workspace\//, "") : undefined,
      evidence: {
        eventIds: [event.id, ...(typeof event.metadata?.sourceEventId === "string" ? [event.metadata.sourceEventId] : [])],
        observedResource: event.resource
      }
    });
  }

  private async require(id: string): Promise<Finding> {
    const finding = await this.store.getFinding(id);
    if (!finding) throw new Error(`Finding not found: ${id}`);
    return finding;
  }
}

function policyFinding(rule: string): { type: FindingType; title: string; fileBased: boolean } {
  if (rule === "unexpected_file_change") return { type: "spec_drift", title: "Unexpected file modification", fileBased: true };
  if (rule === "sensitive_file_change") return { type: "sensitive_change", title: "Sensitive file modification", fileBased: true };
  if (rule === "network_scope") return { type: "network", title: "Unapproved network destination", fileBased: false };
  if (rule === "permission_scope") return { type: "permission", title: "Permission scope violation", fileBased: true };
  return { type: "other", title: "Policy violation", fileBased: false };
}

function sameFinding(existing: Finding, draft: FindingDraft): boolean {
  return (
    existing.runId === draft.runId &&
    existing.source === draft.source &&
    existing.type === draft.type &&
    existing.title === draft.title &&
    existing.evidence?.observedResource === draft.evidence?.observedResource &&
    existing.reviewId === draft.reviewId
  );
}
