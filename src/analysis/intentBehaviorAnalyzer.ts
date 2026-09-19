import type { FindingDraft } from "../findings/findingService.js";
import { matchesAny } from "../policy/policyEngine.js";
import { normalizeExpectedFile } from "../intent/intentService.js";
import type { AgentEvent, AgentIntent, BehaviorSummary, EvidenceVerification, RunRecord } from "../types.js";
import { BehaviorAnalyzer, type BehaviorAnalysis } from "./behaviorAnalyzer.js";
import { buildObservedBehavior, type ObservedBehavior } from "./observedBehavior.js";

export interface IntentBehaviorAnalysis extends BehaviorAnalysis {
  observed: ObservedBehavior;
}

const TEST_COMMAND = /(^|\s)(npm|pnpm|yarn|bun)( run)? test|(^|\s)(pytest|cargo test|go test|vitest|jest|mocha)(\s|$)/i;

/**
 * Compares declared intent with observed behavior. Wraps the Phase 2 BehaviorAnalyzer for the
 * "unexpected X" checks and adds: evidence verification on every finding, undeclared commands/tools
 * (agent-reported, low severity), and missing expected actions (always inferred, never high).
 */
export class IntentBehaviorAnalyzer {
  constructor(private readonly base = new BehaviorAnalyzer()) {}

  analyze(run: RunRecord, intent: AgentIntent, events: AgentEvent[]): IntentBehaviorAnalysis {
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const baseline = this.base.analyze(run, intent, events);
    const declaresTestCommand = intent.expectedCommands.some((command) => TEST_COMMAND.test(command));
    const findings: FindingDraft[] = baseline.findings
      .filter((draft) => !(declaresTestCommand && draft.title === "No test execution observed"))
      .map((draft) => withVerification(draft, intent, eventsById));
    const observed = buildObservedBehavior(run, events, baseline.summary);
    const base = { taskId: run.taskId, runId: run.id, intentId: intent.id, requestId: run.requestId };

    findings.push(...undeclaredCommands(base, intent, baseline.summary, eventsById));
    findings.push(...undeclaredTools(base, intent, observed));
    findings.push(...missingExpectedFiles(base, intent, baseline.summary));
    findings.push(...missingExpectedCommands(base, intent, baseline.summary, observed));

    return { summary: baseline.summary, findings, observed };
  }
}

type Base = { taskId: string; runId: string; intentId: string; requestId?: string };

function withVerification(draft: FindingDraft, intent: AgentIntent, eventsById: Map<string, AgentEvent>): FindingDraft {
  const verification = draft.evidence?.eventIds?.length ? strongestVerification(draft.evidence.eventIds, eventsById) : "inferred";
  const type = draft.evidence?.eventIds?.length ? draft.type : draft.type === "other" || draft.type === "tests" ? "missing_action" : draft.type;
  return {
    ...draft,
    type,
    evidence: { ...draft.evidence, intentId: intent.id, requestId: intent.requestId, verification }
  };
}

function strongestVerification(eventIds: string[], eventsById: Map<string, AgentEvent>): EvidenceVerification {
  const levels = eventIds.map((id) => eventsById.get(id)?.verification ?? "inferred");
  if (levels.includes("independent")) return "independent";
  if (levels.includes("agent_reported")) return "agent_reported";
  return "inferred";
}

function undeclaredCommands(base: Base, intent: AgentIntent, summary: BehaviorSummary, eventsById: Map<string, AgentEvent>): FindingDraft[] {
  if (!intent.expectedCommands.length) return [];
  const findings: FindingDraft[] = [];
  const seen = new Set<string>();
  for (const command of summary.commands) {
    const event = eventsById.get(command.eventIds[0] ?? "");
    if (!event || event.action === "start") continue;
    if (seen.has(command.resource) || commandMatches(command.resource, intent.expectedCommands)) continue;
    seen.add(command.resource);
    findings.push({
      ...base,
      source: "intent_comparison",
      type: "permission",
      severity: "low",
      title: "Undeclared command executed",
      description: `The agent reported running '${command.resource}', which does not match any declared expected command. Command telemetry is agent-reported, not independently observed.`,
      evidence: {
        eventIds: command.eventIds,
        observedResource: command.resource,
        declaredResource: intent.expectedCommands.join(", "),
        intentId: base.intentId,
        requestId: base.requestId,
        verification: strongestVerification(command.eventIds, eventsById)
      }
    });
  }
  return findings;
}

function undeclaredTools(base: Base, intent: AgentIntent, observed: ObservedBehavior): FindingDraft[] {
  if (!intent.expectedTools.length) return [];
  const declared = new Set(intent.expectedTools.map((tool) => tool.toLowerCase()));
  return observed.tools
    .filter((tool) => !declared.has(tool.name.toLowerCase()) && !declared.has(toolFamily(tool.name)))
    .map((tool) => ({
      ...base,
      source: "intent_comparison" as const,
      type: "permission" as const,
      severity: "low" as const,
      title: "Undeclared tool used",
      description: `The agent reported using tool '${tool.name}', which was not listed in expectedTools. Tool usage is agent-reported.`,
      evidence: {
        eventIds: tool.eventIds,
        observedResource: tool.name,
        declaredResource: intent.expectedTools.join(", "),
        intentId: base.intentId,
        requestId: base.requestId,
        verification: tool.verification
      }
    }));
}

function missingExpectedFiles(base: Base, intent: AgentIntent, summary: BehaviorSummary): FindingDraft[] {
  const modified = summary.filesModified.map((file) => normalizeExpectedFile(file.resource));
  return intent.expectedFiles
    .filter((expected) => !expected.includes("*") && !modified.some((file) => matchesAny(file, [expected])))
    .map((expected) => ({
      ...base,
      source: "intent_comparison" as const,
      type: "missing_action" as const,
      severity: "info" as const,
      title: "Expected file not modified",
      description: `The intent listed '${expected}' as an expected file, but Git shows no change to it. The agent may have inspected it or found no change necessary.`,
      evidence: { declaredResource: expected, intentId: base.intentId, requestId: base.requestId, verification: "inferred" as const }
    }));
}

function missingExpectedCommands(base: Base, intent: AgentIntent, summary: BehaviorSummary, observed: ObservedBehavior): FindingDraft[] {
  const observedCommands = [...summary.commands.map((command) => command.resource), ...summary.tests.map((test) => test.command)];
  return intent.expectedCommands
    .filter((expected) => !observedCommands.some((command) => commandMatches(command, [expected])))
    .filter((expected) => !(TEST_COMMAND.test(expected) && summary.tests.length > 0))
    .map((expected) => ({
      ...base,
      source: "intent_comparison" as const,
      type: "missing_action" as const,
      severity: TEST_COMMAND.test(expected) ? ("medium" as const) : ("low" as const),
      title: "Declared command not observed",
      description: `The intent declared '${expected}' but no matching command appears in process or agent telemetry (coverage: ${observed.coverage.shellCommands}). Absence of evidence is not proof the command did not run.`,
      evidence: { declaredResource: expected, intentId: base.intentId, requestId: base.requestId, verification: "inferred" as const }
    }));
}

export function commandMatches(observed: string, expected: string[]): boolean {
  const normalizedObserved = normalizeCommand(observed);
  return expected.some((candidate) => {
    const normalized = normalizeCommand(candidate);
    return normalizedObserved === normalized || normalizedObserved.startsWith(`${normalized} `) || normalizedObserved.includes(normalized);
  });
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function toolFamily(name: string): string {
  const lower = name.toLowerCase();
  if (/^(bash|shell|exec|run_command|command|terminal)/.test(lower)) return "shell";
  if (/^(read|write|edit|create|delete|ls|glob|grep|list_dir|search)/.test(lower)) return "filesystem";
  if (/^(web|fetch|http|browser)/.test(lower)) return "network";
  return lower;
}
