import type { EventCollector } from "../events/eventCollector.js";
import type { AgentEvent, EventCategory, EventInput, RunRecord } from "../types.js";
import type { SandboxOutput } from "../runtime/sandboxProvider.js";

const EVENT_PREFIX = "AGENTGUARD_EVENT ";
const SELF_REPORTED_CATEGORIES = new Set<EventCategory>(["agent", "process", "mcp"]);
const MAX_OUTPUT_TEXT = 16 * 1024;

type ObservedEvent = Pick<EventInput, "category" | "action"> &
  Partial<Pick<EventInput, "resource" | "allowed" | "severity" | "metadata">>;

export class AgentOutputMonitor {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: RunRecord,
    private readonly events: EventCollector
  ) {}

  observe(output: SandboxOutput): void {
    const sequence = ++this.sequence;
    this.queue = this.queue
      .then(() => this.process(output, sequence))
      .catch((error: unknown) => this.emitDegraded(error, sequence));
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async process(output: SandboxOutput, sequence: number): Promise<void> {
    if (output.line.startsWith(EVENT_PREFIX)) {
      const event = parseAgentGuardEvent(output.line.slice(EVENT_PREFIX.length));
      await this.emit(event, output, sequence, "agentguard_protocol");
      return;
    }

    const structured = parseJson(output.line);
    if (structured) {
      const normalized = normalizeVendorRecord(this.run.agent?.kind ?? "generic", structured);
      if (normalized.length) {
        for (const event of normalized) await this.emit(event, output, sequence, "vendor_jsonl");
        return;
      }
    }

    await this.emit(
      {
        category: "process",
        action: "output",
        resource: this.run.command[0],
        severity: output.stream === "stderr" ? "low" : "info",
        metadata: { text: output.line.slice(0, MAX_OUTPUT_TEXT) }
      },
      output,
      sequence,
      "raw"
    );
  }

  private async emit(
    event: ObservedEvent,
    output: SandboxOutput,
    sequence: number,
    format: "agentguard_protocol" | "vendor_jsonl" | "raw"
  ): Promise<void> {
    await this.events.emitEvent({
      runId: this.run.id,
      taskId: this.run.taskId,
      agentId: this.run.agentId,
      ...event,
      metadata: {
        ...event.metadata,
        stream: output.stream,
        sequence,
        format
      }
    });
  }

  private async emitDegraded(error: unknown, sequence: number): Promise<void> {
    await this.events.emitEvent({
      runId: this.run.id,
      taskId: this.run.taskId,
      agentId: this.run.agentId,
      category: "runtime",
      action: "telemetry_degraded",
      severity: "medium",
      metadata: {
        subsystem: "agent_output",
        sequence,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function parseAgentGuardEvent(json: string): ObservedEvent {
  const record = parseJson(json);
  if (!record) throw new Error("Malformed AGENTGUARD_EVENT JSON");
  const category = stringValue(record.category) as EventCategory | undefined;
  const action = stringValue(record.action);
  if (!category || !SELF_REPORTED_CATEGORIES.has(category)) {
    throw new Error("AGENTGUARD_EVENT category must be agent, process, or mcp");
  }
  if (!action) throw new Error("AGENTGUARD_EVENT action is required");

  return {
    category,
    action,
    resource: stringValue(record.resource),
    severity: severityValue(record.severity),
    metadata: {
      ...(objectValue(record.metadata) ?? {}),
      reportedByAgent: true
    }
  };
}

function normalizeVendorRecord(agentKind: string, record: Record<string, unknown>): ObservedEvent[] {
  if (agentKind === "codex") return normalizeCodex(record);
  if (agentKind === "claude_code") return normalizeClaude(record);
  if (agentKind === "cursor") return normalizeCursor(record);
  return [];
}

function normalizeCodex(record: Record<string, unknown>): ObservedEvent[] {
  const type = stringValue(record.type);
  const item = objectValue(record.item);
  if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
    return [{ category: "agent", action: type.replace("turn.", "turn_"), metadata: compact(record, ["usage", "error"]) }];
  }
  if (!type || !item) return [];

  const itemType = stringValue(item.type);
  if (itemType === "agent_message") {
    return [{ category: "agent", action: "message", metadata: { text: stringValue(item.text) ?? "" } }];
  }
  if (itemType === "reasoning") {
    return [{ category: "agent", action: "reasoning_summary", metadata: compact(item, ["text", "summary"]) }];
  }
  if (itemType === "command_execution") {
    const completed = type === "item.completed";
    return [{
      category: "process",
      action: completed ? "command_exit" : "command_start",
      resource: stringValue(item.command) ?? "shell",
      metadata: compact(item, completed ? ["exit_code", "status", "aggregated_output"] : ["command", "status"])
    }];
  }
  if (itemType === "mcp_tool_call") {
    const completed = type === "item.completed";
    return [{
      category: "mcp",
      action: completed ? "tool_result" : "tool_call",
      resource: toolResource(item),
      metadata: compact(item, completed ? ["status", "result", "error"] : ["server", "tool", "arguments"])
    }];
  }
  return [];
}

function normalizeClaude(record: Record<string, unknown>): ObservedEvent[] {
  const type = stringValue(record.type);
  if (type === "system") {
    return [{ category: "agent", action: "session_started", metadata: compact(record, ["subtype", "session_id", "tools", "mcp_servers"]) }];
  }
  if (type === "result") {
    return [{
      category: "agent",
      action: record.is_error ? "failed" : "completed",
      severity: record.is_error ? "medium" : "info",
      metadata: compact(record, ["subtype", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd", "result"])
    }];
  }

  const message = objectValue(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: ObservedEvent[] = [];
  for (const block of content) {
    const value = objectValue(block);
    if (!value) continue;
    const blockType = stringValue(value.type);
    if (blockType === "text") {
      events.push({ category: "agent", action: "message", metadata: { text: stringValue(value.text) ?? "" } });
    } else if (blockType === "tool_use") {
      const name = stringValue(value.name) ?? "tool";
      events.push({
        category: name.startsWith("mcp__") ? "mcp" : "agent",
        action: "tool_call",
        resource: name,
        metadata: { toolCallId: stringValue(value.id), arguments: value.input }
      });
    } else if (blockType === "tool_result") {
      events.push({
        category: "agent",
        action: "tool_result",
        resource: stringValue(value.tool_use_id),
        metadata: compact(value, ["tool_use_id", "is_error", "content"])
      });
    }
  }
  return events;
}

function normalizeCursor(record: Record<string, unknown>): ObservedEvent[] {
  const type = stringValue(record.type) ?? stringValue(record.event);
  const subtype = stringValue(record.subtype);
  if (type === "result" || type === "completed") {
    return [{ category: "agent", action: "completed", metadata: compact(record, ["subtype", "duration_ms", "result", "usage"]) }];
  }
  if (type === "assistant" || type === "message") {
    const text = stringValue(record.text) ?? stringValue(objectValue(record.message)?.content);
    if (text) return [{ category: "agent", action: "message", metadata: { text } }];
  }
  if (type === "tool_call" || subtype === "tool_call") {
    const tool = objectValue(record.tool) ?? record;
    return [{
      category: "agent",
      action: "tool_call",
      resource: stringValue(tool.name) ?? stringValue(record.name) ?? "tool",
      metadata: compact(record, ["name", "arguments", "input", "id"])
    }];
  }
  if (type === "tool_result" || subtype === "tool_result") {
    return [{ category: "agent", action: "tool_result", metadata: compact(record, ["name", "result", "output", "id", "error"]) }];
  }
  return [];
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function severityValue(value: unknown): AgentEvent["severity"] {
  return ["info", "low", "medium", "high", "critical"].includes(String(value))
    ? (value as AgentEvent["severity"])
    : "info";
}

function compact(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function toolResource(item: Record<string, unknown>): string {
  const server = stringValue(item.server) ?? stringValue(item.server_name);
  const tool = stringValue(item.tool) ?? stringValue(item.tool_name) ?? "tool";
  return server ? `${server}/${tool}` : tool;
}
