import path from "node:path";
import type { AgentIntent, AgentIntentDraft, IntentAlignment, IntentApproval } from "../types.js";
import { JsonStore, normalizeStoredIntent } from "../store/jsonStore.js";

export { normalizeStoredIntent };
import { createId } from "../utils/id.js";

export class IntentService {
  constructor(private readonly store: JsonStore) {}

  async create(
    taskId: string,
    draft: AgentIntentDraft,
    defaults: { agentId: string; agentType: string; runId?: string; requestId?: string; planningRunId?: string; supersedes?: string }
  ): Promise<AgentIntent> {
    if (!taskId?.trim()) throw new Error("taskId is required for intent");
    const normalized = validateIntentDraft(draft);
    const intent: AgentIntent = {
      id: createId("intent"),
      taskId,
      runId: defaults.runId,
      requestId: defaults.requestId,
      planningRunId: defaults.planningRunId,
      supersedes: defaults.supersedes,
      ...normalized,
      createdBy: normalized.createdBy ?? { agentId: defaults.agentId, agentType: defaults.agentType },
      createdAt: new Date().toISOString()
    };
    await this.store.createIntent(intent);
    if (defaults.supersedes) await this.store.updateIntent(defaults.supersedes, { supersededBy: intent.id });
    return intent;
  }

  async get(intentId: string): Promise<AgentIntent | undefined> {
    const intent = await this.store.getIntent(intentId);
    return intent ? normalizeStoredIntent(intent) : undefined;
  }

  async recordAlignment(intentId: string, alignment: IntentAlignment): Promise<AgentIntent> {
    const updated = await this.store.updateIntent(intentId, { alignment });
    if (!updated) throw new Error(`Intent not found: ${intentId}`);
    return updated;
  }

  async approve(intentId: string, decision: { actor?: string; reason?: string }): Promise<AgentIntent> {
    return this.decide(intentId, "approved", decision);
  }

  async reject(intentId: string, decision: { actor?: string; reason?: string }): Promise<AgentIntent> {
    return this.decide(intentId, "rejected", decision);
  }

  /**
   * Returns undefined when the intent may be executed, otherwise the reason execution is blocked.
   */
  executionBlockReason(intent: AgentIntent): string | undefined {
    if (intent.supersededBy) return `Intent ${intent.id} was superseded by ${intent.supersededBy}`;
    if (intent.approval?.status === "rejected") return `Intent ${intent.id} was rejected${intent.approval.reason ? `: ${intent.approval.reason}` : ""}`;
    if (intent.requestId && !intent.alignment) return `Intent ${intent.id} has no request alignment decision yet`;
    if (intent.alignment?.status === "conflict" && intent.approval?.status !== "approved") {
      return `Intent ${intent.id} conflicts with the human request and requires human approval before execution`;
    }
    return undefined;
  }

  private async decide(
    intentId: string,
    status: IntentApproval["status"],
    decision: { actor?: string; reason?: string }
  ): Promise<AgentIntent> {
    const intent = await this.store.getIntent(intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.runId) throw new Error(`Intent ${intentId} is already attached to run ${intent.runId}`);
    if (intent.supersededBy) throw new Error(`Intent ${intentId} was superseded by ${intent.supersededBy}`);
    const approval: IntentApproval = { status, actor: decision.actor, reason: decision.reason, at: new Date().toISOString() };
    return (await this.store.updateIntent(intentId, { approval })) ?? intent;
  }

  async attachToRun(intentId: string, runId: string, taskId: string): Promise<AgentIntent> {
    const intent = await this.store.getIntent(intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.taskId !== taskId) throw new Error("Intent taskId does not match run taskId");
    if (intent.runId && intent.runId !== runId) throw new Error("Intent is already attached to another run");
    const blocked = this.executionBlockReason(intent);
    if (blocked) throw new Error(blocked);
    return (await this.store.updateIntent(intent.id, { runId })) ?? intent;
  }

  parseGeneratedOutput(output: unknown): AgentIntentDraft {
    let value = output;
    if (typeof output === "string") {
      try {
        value = JSON.parse(output);
      } catch {
        throw new Error("Generated intent is not valid JSON");
      }
    }
    const record = objectValue(value);
    if (!record) throw new Error("Generated intent must be a JSON object");
    return validateIntentDraft((objectValue(record.intent) ?? record) as unknown as AgentIntentDraft);
  }
}

type NormalizedIntentDraft = Omit<Required<AgentIntentDraft>, "createdBy"> & { createdBy?: AgentIntentDraft["createdBy"] };

export function validateIntentDraft(value: AgentIntentDraft): NormalizedIntentDraft {
  const record = objectValue(value);
  if (!record) throw new Error("Intent must be an object");
  const goal = requiredString(record.goal, "intent.goal");
  const plannedChanges =
    record.plannedChanges === undefined && record.plannedActions !== undefined
      ? stringArray(record.plannedActions, "intent.plannedActions", true)
      : stringArray(record.plannedChanges, "intent.plannedChanges", true);
  const expectedFiles = stringArray(record.expectedFiles, "intent.expectedFiles").map(normalizeExpectedFile);
  const constraints = stringArray(record.constraints, "intent.constraints");
  const createdByRecord = objectValue(record.createdBy);
  const summary = optionalString(record.summary) ?? goal;

  return {
    goal,
    summary,
    interpretation: optionalString(record.interpretation) ?? summary,
    plannedChanges,
    plannedActions: plannedChanges,
    expectedFiles: unique(expectedFiles),
    expectedDependencies: unique(stringArray(record.expectedDependencies, "intent.expectedDependencies").map(normalizeDependency)),
    expectedCommands: unique(stringArray(record.expectedCommands, "intent.expectedCommands").map((value) => value.trim())),
    expectedNetwork: unique(stringArray(record.expectedNetwork, "intent.expectedNetwork").map(normalizeHostname)),
    expectedMcpServers: unique(stringArray(record.expectedMcpServers, "intent.expectedMcpServers").map(normalizeName)),
    expectedTools: unique(stringArray(record.expectedTools, "intent.expectedTools").map(normalizeName)),
    expectedSecrets: unique(stringArray(record.expectedSecrets, "intent.expectedSecrets").map((value) => value.trim())),
    constraints,
    assumptions: stringArray(record.assumptions, "intent.assumptions"),
    createdBy: createdByRecord
      ? {
          agentId: requiredString(createdByRecord.agentId, "intent.createdBy.agentId"),
          agentType: requiredString(createdByRecord.agentType, "intent.createdBy.agentType")
        }
      : undefined
  };
}

export function normalizeExpectedFile(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/workspace\/?/, "").replace(/^\.\//, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Invalid expected file path: ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeDependency(value: string): string {
  return value.trim().toLowerCase().replace(/[_.]+/g, "-");
}

export function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) throw new Error("Network destination cannot be empty");
  if (trimmed.startsWith("*.")) return `*.${normalizeHostname(trimmed.slice(2))}`;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new Error(`Invalid network destination: ${value}`);
  }
}

export function normalizeName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Expected resource name cannot be empty");
  return normalized;
}

function stringArray(value: unknown, name: string, requireNonEmpty = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  if (requireNonEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  return value.map((item) => (item as string).trim());
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
