import { EventEmitter } from "node:events";
import type { AgentEvent, EventInput } from "../types.js";
import { JsonStore } from "../store/jsonStore.js";
import { PolicyEngine } from "../policy/policyEngine.js";
import { Redactor } from "../security/redaction.js";
import { createId } from "../utils/id.js";

export type EventListener = (event: AgentEvent) => void;

export class EventCollector {
  private readonly emitter = new EventEmitter();
  private readonly runSecrets = new Map<string, { secretNames: string[]; secretValues: string[] }>();

  constructor(
    private readonly store: JsonStore,
    private readonly policyEngine: PolicyEngine,
    private readonly redactor = new Redactor()
  ) {
    this.emitter.setMaxListeners(200);
  }

  async emitEvent(input: EventInput): Promise<AgentEvent> {
    const event = this.normalize(input);
    await this.store.addEvent(event);
    this.emitter.emit(event.runId, event);
    this.emitter.emit("*", event);

    const policyEvents = await this.policyEngine.evaluate(event);
    for (const policyEvent of policyEvents) {
      await this.emitEvent(policyEvent);
    }

    return event;
  }

  subscribe(runId: string, listener: EventListener): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  subscribeAll(listener: EventListener): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }

  registerSecrets(runId: string, secrets: Record<string, string>): void {
    this.runSecrets.set(runId, {
      secretNames: Object.keys(secrets),
      secretValues: Object.values(secrets).filter(Boolean)
    });
  }

  clearSecrets(runId: string): void {
    this.runSecrets.delete(runId);
  }

  getEvents(runId: string): Promise<AgentEvent[]> {
    return this.store.getEvents(runId);
  }

  private normalize(input: EventInput): AgentEvent {
    const generallySanitized = this.redactor.sanitize(input);
    const sanitized = new Redactor(this.runSecrets.get(input.runId)).sanitize(generallySanitized);
    return {
      id: createId("evt"),
      timestamp: new Date().toISOString(),
      runId: sanitized.runId,
      taskId: sanitized.taskId,
      agentId: sanitized.agentId,
      category: sanitized.category,
      action: sanitized.action,
      resource: sanitized.resource,
      allowed: sanitized.allowed,
      severity: sanitized.severity,
      metadata: sanitized.metadata,
      evidenceSource: sanitized.evidenceSource ?? evidenceProvenance(sanitized).evidenceSource,
      verification: sanitized.verification ?? evidenceProvenance(sanitized).verification,
      correlationId: sanitized.correlationId
    };
  }
}

function evidenceProvenance(event: EventInput): Pick<AgentEvent, "evidenceSource" | "verification"> {
  if (event.category === "filesystem") return { evidenceSource: "filesystem", verification: "independent" };
  if (event.category === "network") return { evidenceSource: "proxy", verification: "independent" };
  if (event.category === "git") return { evidenceSource: "git", verification: "independent" };
  if (event.category === "policy") return { evidenceSource: "runtime", verification: "inferred" };
  if (event.category === "agent" || event.category === "mcp") {
    return { evidenceSource: "agent_reported", verification: "agent_reported" };
  }
  if (event.category === "process" && event.metadata?.format === "vendor_jsonl") {
    return { evidenceSource: "agent_reported", verification: "agent_reported" };
  }
  return { evidenceSource: "runtime", verification: "independent" };
}
