import { describe, expect, it } from "vitest";
import { extractGeneratedIntent, intentFromText } from "../src/intent/generatedIntentExtractor.js";
import type { AgentEvent } from "../src/types.js";

const intent = { goal: "Fix login", plannedActions: ["Inspect session"], expectedFiles: ["src/auth/session.ts"] };

function event(partial: Partial<AgentEvent> & { category: AgentEvent["category"]; action: string }): AgentEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    runId: "run-1",
    taskId: "task-1",
    agentId: "planner",
    timestamp: new Date().toISOString(),
    severity: "info",
    source: "agent_reported",
    verification: "agent_reported",
    ...partial
  } as AgentEvent;
}

describe("generatedIntentExtractor", () => {
  it("prefers native agent.intent events", () => {
    const events = [event({ category: "agent", action: "intent", metadata: { intent } })];
    expect(extractGeneratedIntent(events)).toEqual(intent);
  });

  it("reads an AGENTGUARD_EVENT line embedded in agent message text", () => {
    const line = `Here you go:\nAGENTGUARD_EVENT ${JSON.stringify({ category: "agent", action: "intent", metadata: { intent } })}`;
    expect(intentFromText(line)).toEqual(intent);
  });

  it("reads a fenced json block from a vendor-normalized message", () => {
    const text = "My plan:\n```json\n" + JSON.stringify(intent, null, 2) + "\n```\nLet me know.";
    expect(extractGeneratedIntent([event({ category: "agent", action: "message", metadata: { text } })])).toEqual(intent);
  });

  it("reads a bare object with prose around it from raw process output", () => {
    const text = `Plan follows ${JSON.stringify({ intent })} done`;
    expect(extractGeneratedIntent([event({ category: "process", action: "output", metadata: { text } })])).toEqual(intent);
  });

  it("uses the newest candidate and ignores non-intent JSON", () => {
    const events = [
      event({ category: "agent", action: "message", metadata: { text: "```json\n" + JSON.stringify({ ...intent, goal: "draft" }) + "\n```" } }),
      event({ category: "agent", action: "message", metadata: { text: JSON.stringify({ type: "tool_result", ok: true }) } }),
      event({ category: "agent", action: "message", metadata: { text: "```json\n" + JSON.stringify(intent) + "\n```" } })
    ];
    expect(extractGeneratedIntent(events)).toEqual(intent);
  });

  it("returns undefined when nothing looks like an intent", () => {
    expect(extractGeneratedIntent([event({ category: "agent", action: "message", metadata: { text: "I looked around. {\"a\":1}" } })])).toBeUndefined();
    expect(intentFromText("no json here")).toBeUndefined();
  });
});
