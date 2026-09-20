import { EventEmitter } from "node:events";
import type { EventCollector } from "../events/eventCollector.js";
import type { JsonStore } from "../store/jsonStore.js";
import type {
  AgentIntent,
  FilePermission,
  IntentAmendment,
  IntentAmendmentChanges,
  PermissionSnapshot,
  RunRecord
} from "../types.js";
import { createId } from "../utils/id.js";
import { IntentService, validateIntentDraft, normalizeExpectedFile, normalizeHostname } from "./intentService.js";

export type PermissionKind = keyof PermissionSnapshot;

/** Appended to builder prompts so real agents know how to ask instead of drifting. */
export const BUILDER_AMENDMENT_INSTRUCTION = [
  "Stay within your approved plan and access scope.",
  "If you discover you must go beyond it (touch other files, add a dependency, reach a host, use a secret/tool/MCP server, or take an action not in the plan), do NOT proceed.",
  "Instead request an intent amendment and wait for a human decision:",
  'POST http://periscope.internal/amendments through the configured HTTP proxy with JSON {"reason":"why this is needed","changes":{"plannedActions":[],"expectedFiles":[],"expectedDependencies":[],"expectedCommands":[],"expectedNetwork":[],"expectedMcpServers":[],"expectedTools":[],"expectedSecrets":[]},"permissions":{"filesystem":[{"path":"...","access":"read_write"}],"network":[],"secrets":[],"mcpServers":[],"tools":[]}}',
  "then poll GET http://periscope.internal/amendments/<id>?wait=60 until status is approved or denied.",
  "If you cannot make HTTP requests, print one line: AGENTGUARD_EVENT {\"category\":\"agent\",\"action\":\"intent_amendment\",\"metadata\":{\"reason\":\"...\",\"changes\":{...},\"permissions\":{...}}} and stop.",
  "Only continue the extra work after approval; if denied, finish what you can within the original plan and report what you skipped."
].join(" ");

/**
 * Applies newly approved grants to a live sandbox. Returns the kinds it could enforce immediately;
 * everything else is recorded on the run's permission snapshot but only takes effect on the next run
 * (e.g. Docker bind mounts and injected secrets are fixed at container creation).
 */
export type LiveGrantApplier = (grants: PermissionSnapshot) => Promise<PermissionKind[]>;

export interface AmendmentRequestInput {
  reason: string;
  changes?: IntentAmendmentChanges;
  permissions?: PermissionSnapshot;
}

const CHANGE_KEYS: Array<keyof IntentAmendmentChanges> = [
  "plannedActions",
  "expectedFiles",
  "expectedDependencies",
  "expectedCommands",
  "expectedNetwork",
  "expectedMcpServers",
  "expectedTools",
  "expectedSecrets"
];

export class IntentAmendmentService {
  private readonly decisions = new EventEmitter();
  private readonly liveAppliers = new Map<string, LiveGrantApplier>();

  constructor(
    private readonly store: JsonStore,
    private readonly events: EventCollector,
    private readonly intents: IntentService
  ) {
    this.decisions.setMaxListeners(200);
  }

  registerLiveApplier(runId: string, applier: LiveGrantApplier): void {
    this.liveAppliers.set(runId, applier);
  }

  unregisterLiveApplier(runId: string): void {
    this.liveAppliers.delete(runId);
  }

  list(runId?: string): Promise<IntentAmendment[]> {
    return this.store.listIntentAmendments(runId);
  }

  get(id: string): Promise<IntentAmendment | undefined> {
    return this.store.getIntentAmendment(id);
  }

  /**
   * Records an agent's request to go beyond its declared intent and pauses the run until a human decides.
   * The sandbox keeps running (the agent is expected to block on the decision), but Periscope marks the
   * run paused so reviewers see that nothing further should happen until they answer.
   */
  async request(runId: string, input: unknown, channel: IntentAmendment["channel"]): Promise<IntentAmendment> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!["starting", "running", "paused"].includes(run.status)) {
      throw new Error(`Run ${runId} is ${run.status}; amendments can only be requested while it is executing`);
    }
    const normalized = normalizeRequest(input);
    if (!hasAnyChange(normalized)) throw new Error("Amendment must request at least one intent change or permission");

    const intent = await this.currentIntent(run);
    const amendment: IntentAmendment = {
      id: createId("amend"),
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      intentId: intent?.id,
      requestId: run.requestId ?? intent?.requestId,
      reason: normalized.reason,
      changes: normalized.changes,
      permissions: normalized.permissions,
      status: "pending",
      channel,
      createdAt: new Date().toISOString()
    };
    await this.store.createIntentAmendment(amendment);
    if (run.status === "running") await this.store.updateRun(run.id, { status: "paused" });

    await this.events.emitEvent({
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      category: "agent",
      action: "intent_amendment_requested",
      resource: amendment.id,
      severity: "medium",
      correlationId: amendment.id,
      metadata: {
        amendmentId: amendment.id,
        intentId: amendment.intentId,
        reason: amendment.reason,
        changes: amendment.changes,
        permissions: amendment.permissions,
        channel,
        runPaused: run.status === "running"
      }
    });
    return amendment;
  }

  approve(id: string, decision: { actor?: string; reason?: string }): Promise<IntentAmendment> {
    return this.decide(id, "approved", decision);
  }

  deny(id: string, decision: { actor?: string; reason?: string }): Promise<IntentAmendment> {
    return this.decide(id, "denied", decision);
  }

  /** Resolves with the amendment once decided, or with the still-pending amendment after `timeoutMs`. */
  async waitForDecision(id: string, timeoutMs: number): Promise<IntentAmendment> {
    const current = await this.get(id);
    if (!current) throw new Error(`Amendment not found: ${id}`);
    if (current.status !== "pending") return current;
    const decided = await new Promise<IntentAmendment | undefined>((resolve) => {
      const done = (amendment?: IntentAmendment) => {
        clearTimeout(timer);
        this.decisions.off(id, done);
        resolve(amendment);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.decisions.on(id, done);
    });
    return decided ?? (await this.get(id)) ?? current;
  }

  private async decide(
    id: string,
    status: "approved" | "denied",
    decision: { actor?: string; reason?: string }
  ): Promise<IntentAmendment> {
    const amendment = await this.get(id);
    if (!amendment) throw new Error(`Amendment not found: ${id}`);
    if (amendment.status !== "pending") throw new Error(`Amendment ${id} was already ${amendment.status}`);
    const run = await this.store.getRun(amendment.runId);
    if (!run) throw new Error(`Run not found: ${amendment.runId}`);

    let resultingIntentId: string | undefined;
    let appliedLive: PermissionKind[] = [];
    let deferred: PermissionKind[] = [];

    if (status === "approved") {
      const intent = amendment.intentId ? await this.intents.get(amendment.intentId) : undefined;
      if (intent && hasAnyChange({ changes: amendment.changes, permissions: {}, reason: "" })) {
        const revised = await this.intents.create(intent.taskId, mergeIntent(intent, amendment.changes), {
          agentId: intent.createdBy.agentId,
          agentType: intent.createdBy.agentType,
          runId: run.id,
          requestId: intent.requestId,
          planningRunId: intent.planningRunId,
          supersedes: intent.id
        });
        await this.store.updateIntent(revised.id, {
          alignment: intent.alignment,
          approval: { status: "approved", actor: decision.actor, reason: `Intent amendment ${amendment.id} approved`, at: new Date().toISOString() }
        });
        resultingIntentId = revised.id;
        await this.store.updateRun(run.id, { intentId: revised.id });
      }

      const requestedKinds = permissionKinds(amendment.permissions);
      if (requestedKinds.length) {
        const current = (await this.store.getPermissions(run.id)) ?? {};
        await this.store.setPermissions(run.id, mergePermissions(current, amendment.permissions));
        const applier = this.liveAppliers.get(run.id);
        appliedLive = applier ? await applier(amendment.permissions) : [];
        deferred = requestedKinds.filter((kind) => !appliedLive.includes(kind));
      }
    }

    const decidedAt = new Date().toISOString();
    const updated = await this.store.updateIntentAmendment(id, {
      status,
      resultingIntentId,
      decision: { actor: decision.actor, reason: decision.reason, at: decidedAt, appliedLive, deferred }
    });
    if (!updated) throw new Error(`Amendment not found: ${id}`);

    const latest = await this.store.getRun(run.id);
    if (latest?.status === "paused") await this.store.updateRun(run.id, { status: "running" });

    await this.events.emitEvent({
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      category: "agent",
      action: status === "approved" ? "intent_amendment_approved" : "intent_amendment_denied",
      resource: amendment.id,
      severity: "info",
      allowed: status === "approved",
      correlationId: amendment.id,
      evidenceSource: "reviewer",
      verification: "independent",
      metadata: {
        amendmentId: amendment.id,
        actor: decision.actor,
        reason: decision.reason,
        previousIntentId: amendment.intentId,
        resultingIntentId,
        appliedLive,
        deferred,
        runResumed: latest?.status === "paused"
      }
    });

    this.decisions.emit(id, updated);
    return updated;
  }

  private async currentIntent(run: RunRecord): Promise<AgentIntent | undefined> {
    if (run.intentId) return this.intents.get(run.intentId);
    const forRun = await this.store.getIntentForRun(run.id);
    return forRun ? this.intents.get(forRun.id) : undefined;
  }
}

function normalizeRequest(input: unknown): { reason: string; changes: IntentAmendmentChanges; permissions: PermissionSnapshot } {
  const record = objectValue(input);
  if (!record) throw new Error("Amendment must be an object");
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason) throw new Error("amendment.reason is required: explain why the plan needs to change");

  const rawChanges = objectValue(record.changes) ?? {};
  const changes: IntentAmendmentChanges = {};
  for (const key of CHANGE_KEYS) {
    const values = stringList(rawChanges[key], `amendment.changes.${key}`);
    if (!values.length) continue;
    changes[key] =
      key === "expectedFiles" ? values.map(normalizeExpectedFile) : key === "expectedNetwork" ? values.map(normalizeHostname) : values;
  }

  const rawPermissions = objectValue(record.permissions) ?? {};
  const permissions: PermissionSnapshot = {};
  const filesystem = Array.isArray(rawPermissions.filesystem) ? rawPermissions.filesystem : [];
  if (filesystem.length) {
    permissions.filesystem = filesystem.map((entry, index): FilePermission => {
      const item = objectValue(entry);
      const path = item && typeof item.path === "string" ? item.path.trim() : "";
      const access = item?.access;
      if (!path) throw new Error(`amendment.permissions.filesystem[${index}].path is required`);
      if (access !== "read" && access !== "read_write") {
        throw new Error(`amendment.permissions.filesystem[${index}].access must be read or read_write`);
      }
      return { path, access };
    });
  }
  const network = stringList(rawPermissions.network, "amendment.permissions.network").map(normalizeHostname);
  if (network.length) permissions.network = network;
  const secrets = stringList(rawPermissions.secrets, "amendment.permissions.secrets");
  if (secrets.length) {
    for (const name of secrets) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid secret name in amendment: ${name}`);
    }
    permissions.secrets = secrets;
  }
  const mcpServers = stringList(rawPermissions.mcpServers, "amendment.permissions.mcpServers");
  if (mcpServers.length) permissions.mcpServers = mcpServers;
  const tools = stringList(rawPermissions.tools, "amendment.permissions.tools");
  if (tools.length) permissions.tools = tools;

  return { reason, changes, permissions };
}

function hasAnyChange(input: { reason: string; changes: IntentAmendmentChanges; permissions: PermissionSnapshot }): boolean {
  return CHANGE_KEYS.some((key) => (input.changes[key]?.length ?? 0) > 0) || permissionKinds(input.permissions).length > 0;
}

export function permissionKinds(permissions: PermissionSnapshot): PermissionKind[] {
  return (Object.keys(permissions) as PermissionKind[]).filter((kind) => (permissions[kind]?.length ?? 0) > 0);
}

export function mergeIntent(intent: AgentIntent, changes: IntentAmendmentChanges): AgentIntent {
  const merged = {
    ...intent,
    plannedChanges: union(intent.plannedChanges, changes.plannedActions),
    plannedActions: union(intent.plannedActions, changes.plannedActions),
    expectedFiles: union(intent.expectedFiles, changes.expectedFiles),
    expectedDependencies: union(intent.expectedDependencies, changes.expectedDependencies),
    expectedCommands: union(intent.expectedCommands, changes.expectedCommands),
    expectedNetwork: union(intent.expectedNetwork, changes.expectedNetwork),
    expectedMcpServers: union(intent.expectedMcpServers, changes.expectedMcpServers),
    expectedTools: union(intent.expectedTools, changes.expectedTools),
    expectedSecrets: union(intent.expectedSecrets, changes.expectedSecrets)
  };
  return { ...intent, ...validateIntentDraft(merged), createdBy: intent.createdBy };
}

export function mergePermissions(current: PermissionSnapshot, extra: PermissionSnapshot): PermissionSnapshot {
  const filesystem = [...(current.filesystem ?? [])];
  for (const grant of extra.filesystem ?? []) {
    const existing = filesystem.find((item) => item.path === grant.path);
    if (!existing) filesystem.push(grant);
    else if (grant.access === "read_write") existing.access = "read_write";
  }
  return {
    ...current,
    ...(filesystem.length ? { filesystem } : {}),
    ...(extra.network?.length || current.network ? { network: union(current.network, extra.network) } : {}),
    ...(extra.secrets?.length || current.secrets ? { secrets: union(current.secrets, extra.secrets) } : {}),
    ...(extra.mcpServers?.length || current.mcpServers
      ? { mcpServers: unionBy([...(current.mcpServers ?? []), ...(extra.mcpServers ?? [])], (item) => (typeof item === "string" ? item : item.id)) }
      : {}),
    ...(extra.tools?.length || current.tools ? { tools: union(current.tools, extra.tools) } : {})
  };
}

function union(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function unionBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be an array of strings`);
  return [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
