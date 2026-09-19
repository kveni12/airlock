import type { AgentEvent } from "../types.js";

const EVENT_MARKER = "AGENTGUARD_EVENT ";
const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

export const PLANNER_OUTPUT_INSTRUCTION = [
  "Analyze the task without modifying the repository; the workspace is mounted read-only and any write will fail the planning run.",
  "Do not run commands that change files, install dependencies, or access the network.",
  "When finished, output your plan as a single JSON object (in a ```json code block, or on one line prefixed with AGENTGUARD_EVENT wrapped as {\"category\":\"agent\",\"action\":\"intent\",\"metadata\":{\"intent\":{...}}}).",
  "The intent object must include: goal, interpretation, plannedActions (string[]), expectedFiles (repo-relative paths), expectedDependencies, expectedCommands, expectedNetwork (hostnames), expectedMcpServers, expectedSecrets (env var names), expectedTools, constraints, and optionally assumptions.",
  "Use empty arrays when nothing is expected. Emit the JSON exactly once."
].join(" ");

/**
 * Finds the structured intent the planner produced. Accepts, in order of preference:
 * 1. a native `agent.intent` event (AGENTGUARD_EVENT protocol),
 * 2. an AGENTGUARD_EVENT line embedded in agent message text,
 * 3. a fenced or bare JSON object containing `goal` in agent message / raw process output text.
 * Scans newest-first so the final answer wins over earlier drafts.
 */
export function extractGeneratedIntent(eventList: AgentEvent[]): unknown {
  for (const event of [...eventList].reverse()) {
    if (event.category === "agent" && event.action === "intent" && event.metadata?.intent) return event.metadata.intent;
    const text = messageText(event);
    if (!text) continue;
    const found = intentFromText(text);
    if (found) return found;
  }
  return undefined;
}

function messageText(event: AgentEvent): string | undefined {
  const isAgentMessage = event.category === "agent" && event.action === "message";
  const isRawOutput = event.category === "process" && event.action === "output";
  if (!isAgentMessage && !isRawOutput) return undefined;
  return typeof event.metadata?.text === "string" ? event.metadata.text : undefined;
}

export function intentFromText(text: string): unknown {
  const marker = text.indexOf(EVENT_MARKER);
  if (marker >= 0) {
    const parsed = parseObject(text.slice(marker + EVENT_MARKER.length));
    const intent = intentOf(parsed);
    if (intent) return intent;
  }
  for (const match of text.matchAll(FENCE)) {
    const intent = intentOf(parseObject(match[1]));
    if (intent) return intent;
  }
  return intentOf(parseObject(text));
}

function intentOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  if (metadata?.intent && typeof metadata.intent === "object") return metadata.intent;
  if (record.intent && typeof record.intent === "object" && "goal" in (record.intent as object)) return record.intent;
  if (typeof record.goal === "string") return record;
  return undefined;
}

/** Parses the first balanced `{...}` object in a string, tolerating surrounding prose. */
function parseObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
