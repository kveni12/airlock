import type { AgentEvent, BehaviorSummary, EvidenceVerification, RunRecord } from "../types.js";

export type CoverageLevel = EvidenceVerification | "unavailable";

/** Per-channel statement of how (and whether) Periscope observed each kind of behavior. */
export interface TelemetryCoverage {
  filesystemWrites: CoverageLevel;
  filesystemReads: CoverageLevel;
  networkProxyTraffic: CoverageLevel;
  directSocketTraffic: CoverageLevel;
  gitChanges: CoverageLevel;
  dependencyChanges: CoverageLevel;
  processLifecycle: CoverageLevel;
  shellCommands: CoverageLevel;
  agentToolCalls: CoverageLevel;
  mcpCalls: CoverageLevel;
  secretAccess: CoverageLevel;
}

export interface Unavailable {
  status: "unavailable";
  reason: string;
}

export interface ObservedItem {
  name: string;
  eventIds: string[];
  verification: EvidenceVerification;
}

/** Compact, dashboard-friendly view of what was observed, with unavailable channels marked as such. */
export interface ObservedBehavior {
  runId: string;
  files: {
    read: Unavailable;
    modified: ObservedItem[];
    created: ObservedItem[];
    deleted: ObservedItem[];
  };
  commands: Array<ObservedItem & { exitCode?: number | null }>;
  tests: Array<ObservedItem & { passed?: boolean }>;
  dependenciesAdded: ObservedItem[];
  dependenciesRemoved: ObservedItem[];
  networkDestinations: Array<ObservedItem & { allowed?: boolean }>;
  secrets: ObservedItem[] | Unavailable;
  mcpCalls: Array<ObservedItem & { server?: string }>;
  tools: ObservedItem[];
  coverage: TelemetryCoverage;
}

export function telemetryCoverage(events: AgentEvent[]): TelemetryCoverage {
  const hasAgentStream = events.some((event) => event.evidenceSource === "agent_reported");
  return {
    filesystemWrites: "independent",
    filesystemReads: "unavailable",
    networkProxyTraffic: "independent",
    directSocketTraffic: "unavailable",
    gitChanges: "independent",
    dependencyChanges: "independent",
    processLifecycle: "independent",
    shellCommands: hasAgentStream ? "agent_reported" : "unavailable",
    agentToolCalls: hasAgentStream ? "agent_reported" : "unavailable",
    mcpCalls: hasAgentStream ? "agent_reported" : "unavailable",
    secretAccess: "unavailable"
  };
}

export function buildObservedBehavior(run: RunRecord, events: AgentEvent[], summary: BehaviorSummary): ObservedBehavior {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const verificationOf = (eventIds: string[]): EvidenceVerification => {
    const levels = eventIds.map((id) => eventsById.get(id)?.verification ?? "inferred");
    if (levels.includes("independent")) return "independent";
    if (levels.includes("agent_reported")) return "agent_reported";
    return "inferred";
  };

  const created = new Set(
    events.filter((event) => event.category === "filesystem" && event.action === "create" && event.resource).map((event) => stripWorkspace(event.resource as string))
  );
  const deleted = new Set(
    events.filter((event) => event.category === "filesystem" && event.action === "delete" && event.resource).map((event) => stripWorkspace(event.resource as string))
  );
  const files: ObservedBehavior["files"] = {
    read: { status: "unavailable", reason: "Filesystem reads are not independently traced in the sandbox" },
    modified: [],
    created: [],
    deleted: []
  };
  for (const file of summary.filesModified) {
    const item = { name: file.resource, eventIds: file.eventIds, verification: verificationOf(file.eventIds) };
    if (deleted.has(file.resource) && !created.has(file.resource)) files.deleted.push(item);
    else if (created.has(file.resource)) files.created.push(item);
    else files.modified.push(item);
  }

  const tools = new Map<string, ObservedItem>();
  for (const event of events) {
    if (event.category !== "agent" || event.action !== "tool_call" || !event.resource) continue;
    const current = tools.get(event.resource) ?? { name: event.resource, eventIds: [], verification: event.verification ?? "agent_reported" };
    current.eventIds.push(event.id);
    tools.set(event.resource, current);
  }

  const coverage = telemetryCoverage(events);
  return {
    runId: run.id,
    files,
    commands: summary.commands
      .filter((command) => eventsById.get(command.eventIds[0] ?? "")?.action !== "start")
      .map((command) => ({ name: command.resource, eventIds: command.eventIds, verification: verificationOf(command.eventIds), exitCode: command.exitCode })),
    tests: summary.tests.map((test) => ({ name: test.command, eventIds: test.eventIds, verification: verificationOf(test.eventIds), passed: test.passed })),
    dependenciesAdded: summary.dependencyChanges
      .filter((change) => change.action === "dependency_added")
      .map((change) => ({ name: change.name, eventIds: change.eventIds, verification: verificationOf(change.eventIds) })),
    dependenciesRemoved: summary.dependencyChanges
      .filter((change) => change.action === "dependency_removed")
      .map((change) => ({ name: change.name, eventIds: change.eventIds, verification: verificationOf(change.eventIds) })),
    networkDestinations: summary.networkDestinations.map((destination) => ({
      name: destination.resource,
      eventIds: destination.eventIds,
      verification: verificationOf(destination.eventIds),
      allowed: destination.allowed
    })),
    secrets: summary.secretsObserved.length
      ? summary.secretsObserved.map((secret) => ({ name: secret.resource, eventIds: secret.eventIds, verification: verificationOf(secret.eventIds) }))
      : { status: "unavailable", reason: "Secret reads inside the sandbox are not traced; only injected-secret availability and redaction hits are recorded" },
    mcpCalls: summary.mcpTools.map((tool) => ({ name: tool.resource, server: tool.server, eventIds: tool.eventIds, verification: tool.verification })),
    tools: [...tools.values()],
    coverage
  };
}

function stripWorkspace(resource: string): string {
  return resource.replace(/^\/workspace\//, "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "");
}
