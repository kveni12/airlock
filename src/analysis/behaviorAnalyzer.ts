import type { AgentEvent, AgentIntent, BehaviorSummary, RunRecord } from "../types.js";
import { matchesAny } from "../policy/policyEngine.js";
import { normalizeDependency, normalizeExpectedFile, normalizeHostname, normalizeName } from "../intent/intentService.js";
import type { FindingDraft } from "../findings/findingService.js";
import { FindingService } from "../findings/findingService.js";
import { JsonStore } from "../store/jsonStore.js";
import { IntentBehaviorAnalyzer } from "./intentBehaviorAnalyzer.js";

export interface BehaviorAnalysis {
  summary: BehaviorSummary;
  findings: FindingDraft[];
}

export class BehaviorAnalyzer {
  analyze(run: RunRecord, intent: AgentIntent, events: AgentEvent[]): BehaviorAnalysis {
    const summary = summarizeBehavior(run, events);
    const findings: FindingDraft[] = [];

    for (const file of summary.filesModified) {
      const resource = normalizeExpectedFile(file.resource);
      if (!intent.expectedFiles.some((expected) => matchesAny(resource, [expected]))) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "spec_drift",
          severity: "high",
          title: "File changed outside declared intent",
          description: `The builder changed '${resource}', which was not included in the declared expected files.`,
          file: resource,
          evidence: {
            eventIds: file.eventIds,
            observedResource: resource,
            declaredResource: intent.expectedFiles.join(", "),
            diffSnippet: diffForFile(run.gitSummary?.diff, resource)
          }
        });
      }
    }

    for (const dependency of summary.dependencyChanges.filter((change) => change.action === "dependency_added")) {
      const name = normalizeDependency(dependency.name);
      if (!intent.expectedDependencies.includes(name)) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "dependency",
          severity: "medium",
          title: "Unexpected dependency added",
          description: `The builder added '${name}' outside the declared dependency plan.`,
          file: run.gitSummary?.dependencyChanges.find((change) => normalizeDependency(change.name) === name)?.manifest,
          evidence: {
            eventIds: dependency.eventIds,
            observedResource: name,
            declaredResource: intent.expectedDependencies.join(", ")
          }
        });
      }
    }

    for (const destination of summary.networkDestinations) {
      const hostname = normalizeHostname(destination.resource);
      if (!hostMatches(hostname, intent.expectedNetwork)) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "network",
          severity: destination.allowed === false ? "high" : "medium",
          title: "Unexpected network destination",
          description: `The builder contacted '${hostname}', which was not declared in its intent.`,
          evidence: {
            eventIds: destination.eventIds,
            observedResource: hostname,
            declaredResource: intent.expectedNetwork.join(", ")
          }
        });
      }
    }

    for (const secret of summary.secretsObserved) {
      if (!intent.expectedSecrets.includes(secret.resource)) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "security",
          severity: "high",
          title: "Unexpected secret access",
          description: `Observed evidence indicates access to '${secret.resource}', which was not declared in intent.`,
          evidence: {
            eventIds: secret.eventIds,
            observedResource: secret.resource,
            declaredResource: intent.expectedSecrets.join(", ")
          }
        });
      }
    }

    const usedServers = new Set(summary.mcpTools.map((tool) => tool.server).filter(Boolean));
    for (const tool of summary.mcpTools) {
      if (tool.server && !intent.expectedMcpServers.includes(normalizeName(tool.server))) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "permission",
          severity: "medium",
          title: "Unexpected MCP server used",
          description: `The builder reported use of MCP server '${tool.server}' outside declared intent.`,
          evidence: {
            eventIds: tool.eventIds,
            observedResource: tool.resource,
            declaredResource: intent.expectedMcpServers.join(", ")
          }
        });
      }
    }
    for (const expected of intent.expectedMcpServers) {
      if (!usedServers.has(expected)) {
        findings.push({
          taskId: run.taskId,
          runId: run.id,
          source: "intent_comparison",
          type: "other",
          severity: "info",
          title: "Declared MCP server not observed",
          description: `MCP server '${expected}' was declared but no tool call was observed.`,
          evidence: { declaredResource: expected }
        });
      }
    }

    const expectsTests = intent.expectedFiles.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./i.test(file));
    if (expectsTests && summary.tests.length === 0) {
      findings.push({
        taskId: run.taskId,
        runId: run.id,
        source: "intent_comparison",
        type: "tests",
        severity: "medium",
        title: "No test execution observed",
        description: "The intent included test files, but Periscope did not observe a test command.",
        evidence: { declaredResource: intent.expectedFiles.filter((file) => /test/i.test(file)).join(", ") }
      });
    }

    return { summary, findings };
  }
}

export interface RunBehaviorAnalyzer {
  analyze(run: RunRecord, intent: AgentIntent, events: AgentEvent[]): BehaviorAnalysis;
}

export class BehaviorAnalysisService {
  private readonly analyzer: RunBehaviorAnalyzer;

  constructor(
    private readonly store: JsonStore,
    private readonly findings: FindingService,
    analyzer?: RunBehaviorAnalyzer
  ) {
    this.analyzer = analyzer ?? new IntentBehaviorAnalyzer();
  }

  async analyzeRun(runId: string): Promise<BehaviorAnalysis> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const [intent, events] = await Promise.all([
      run.intentId ? this.store.getIntent(run.intentId) : this.store.getIntentForRun(runId),
      this.store.getEvents(runId)
    ]);
    if (!intent) throw new Error(`Run ${runId} has no attached intent`);
    if (!run.gitSummary) throw new Error(`Run ${runId} has no final Git summary`);
    const analysis = this.analyzer.analyze(run, intent, events);
    for (const draft of analysis.findings) await this.findings.create(draft);
    return analysis;
  }
}

export function summarizeBehavior(run: RunRecord, events: AgentEvent[]): BehaviorSummary {
  const gitFiles = events.filter((event) => event.category === "git" && event.action === "file_changed" && event.resource);
  const fileEvents = gitFiles.length
    ? gitFiles
    : events.filter((event) => event.category === "filesystem" && ["create", "write", "delete"].includes(event.action) && event.resource);

  return {
    runId: run.id,
    filesModified: groupResources(fileEvents, (event) => normalizeWorkspaceResource(event.resource as string)),
    dependencyChanges: groupDependencies(events),
    networkDestinations: groupNetwork(events),
    secretsObserved: groupResources(
      events.filter((event) => event.category === "secret" && event.action === "access" && event.resource),
      (event) => event.resource as string
    ),
    mcpTools: groupMcp(events),
    commands: groupCommands(events),
    tests: groupTests(events)
  };
}

function groupResources(
  events: AgentEvent[],
  resourceFor: (event: AgentEvent) => string
): Array<{ resource: string; eventIds: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const event of events) {
    const resource = resourceFor(event);
    grouped.set(resource, [...(grouped.get(resource) ?? []), event.id]);
  }
  return [...grouped].map(([resource, eventIds]) => ({ resource, eventIds }));
}

function groupDependencies(events: AgentEvent[]): BehaviorSummary["dependencyChanges"] {
  const grouped = new Map<string, { name: string; action: "dependency_added" | "dependency_removed"; eventIds: string[] }>();
  for (const event of events) {
    if (event.category !== "git" || !["dependency_added", "dependency_removed"].includes(event.action) || !event.resource) continue;
    const action = event.action as "dependency_added" | "dependency_removed";
    const name = normalizeDependency(event.resource);
    const key = `${action}:${name}`;
    const current = grouped.get(key) ?? { name, action, eventIds: [] };
    current.eventIds.push(event.id);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function groupNetwork(events: AgentEvent[]): BehaviorSummary["networkDestinations"] {
  const grouped = new Map<string, { resource: string; allowed?: boolean; eventIds: string[] }>();
  for (const event of events) {
    if (event.category !== "network" || !event.resource) continue;
    const resource = normalizeHostname(event.resource);
    const current = grouped.get(resource) ?? { resource, allowed: event.allowed, eventIds: [] };
    current.allowed = current.allowed !== false && event.allowed !== false;
    current.eventIds.push(event.id);
    grouped.set(resource, current);
  }
  return [...grouped.values()];
}

function groupMcp(events: AgentEvent[]): BehaviorSummary["mcpTools"] {
  const grouped = new Map<string, BehaviorSummary["mcpTools"][number]>();
  for (const event of events) {
    if (event.category !== "mcp" || event.action !== "tool_call" || !event.resource) continue;
    const [server] = event.resource.split("/");
    const current = grouped.get(event.resource) ?? {
      resource: event.resource,
      server: normalizeName(server),
      eventIds: [],
      verification: event.verification ?? "agent_reported"
    };
    current.eventIds.push(event.id);
    grouped.set(event.resource, current);
  }
  return [...grouped.values()];
}

function groupCommands(events: AgentEvent[]): BehaviorSummary["commands"] {
  return events
    .filter((event) => event.category === "process" && ["start", "command_start"].includes(event.action) && event.resource)
    .map((event) => ({ resource: event.resource as string, eventIds: [event.id] }));
}

function groupTests(events: AgentEvent[]): BehaviorSummary["tests"] {
  const tests: BehaviorSummary["tests"] = [];
  for (const event of events) {
    const command = commandText(event);
    if (!command || !/(^|\s)(npm test|pnpm test|yarn test|pytest|cargo test|go test)(\s|$)/i.test(command)) continue;
    const exitCode = typeof event.metadata?.exitCode === "number" ? event.metadata.exitCode : undefined;
    tests.push({ command, passed: exitCode === undefined ? undefined : exitCode === 0, eventIds: [event.id] });
  }
  return tests;
}

function commandText(event: AgentEvent): string | undefined {
  if (event.category === "process" && ["start", "command_start", "command_exit"].includes(event.action)) {
    if (typeof event.metadata?.command === "string") return event.metadata.command;
    if (Array.isArray(event.metadata?.command)) return event.metadata.command.join(" ");
    return event.resource;
  }
  if (event.category === "agent" && ["tool_call", "tool_result"].includes(event.action)) {
    return typeof event.metadata?.command === "string" ? event.metadata.command : undefined;
  }
  return undefined;
}

function normalizeWorkspaceResource(resource: string): string {
  return resource.replace(/^\/workspace\//, "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "");
}

function hostMatches(hostname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = normalizeHostname(pattern);
    return normalized.startsWith("*.")
      ? hostname === normalized.slice(2) || hostname.endsWith(`.${normalized.slice(2)}`)
      : hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function diffForFile(diff: string | undefined, file: string): string | undefined {
  if (!diff) return undefined;
  const marker = `diff --git a/${file} b/${file}`;
  const start = diff.indexOf(marker);
  if (start < 0) return undefined;
  const next = diff.indexOf("\ndiff --git ", start + marker.length);
  return diff.slice(start, next < 0 ? undefined : next).slice(0, 4000);
}
