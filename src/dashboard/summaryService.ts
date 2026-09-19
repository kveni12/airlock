import type { AgentEvent, Finding, MCPServer, PermissionSnapshot, RunRecord } from "../types.js";
import { JsonStore } from "../store/jsonStore.js";

export class SummaryService {
  constructor(private readonly store: JsonStore) {}

  async dashboard() {
    const [runs, findings, reviews] = await Promise.all([
      this.store.listRuns(),
      this.store.listFindings(),
      this.store.listReviews()
    ]);
    const activeRuns = runs.filter((run) => ["pending", "starting", "running", "stopping"].includes(run.status));
    const openFindings = findings.filter((finding) => ["open", "resolving", "re_reviewing"].includes(finding.status));
    const accessRisks = openFindings.filter((finding) => ["security", "permission", "network"].includes(finding.type));
    return {
      activeAgents: new Set(activeRuns.map((run) => run.agentId)).size,
      accessRisks: {
        total: accessRisks.length,
        high: accessRisks.filter((finding) => ["high", "critical"].includes(finding.severity)).length
      },
      reviews: {
        filesReviewed: reviews.reduce((total, review) => total + review.filesReviewed, 0),
        filesTotal: reviews.reduce((total, review) => total + review.filesTotal, 0)
      },
      findings: {
        open: openFindings.length,
        high: openFindings.filter((finding) => finding.severity === "high").length,
        critical: openFindings.filter((finding) => finding.severity === "critical").length
      },
      riskSummary: riskSummary(openFindings),
      activeRuns,
      recentFindings: [...findings].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
      reviewsInProgress: reviews.filter((review) => ["pending", "reviewing"].includes(review.status))
    };
  }

  async agent(agentId: string) {
    const runs = (await this.store.listRuns())
      .filter((run) => run.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const currentRun = runs.find((run) => ["pending", "starting", "running", "stopping"].includes(run.status)) ?? runs[0];
    if (!currentRun) throw new Error(`Agent not found: ${agentId}`);
    const [permissions, events, findings, intent] = await Promise.all([
      this.store.getPermissions(currentRun.id),
      this.store.getEvents(currentRun.id),
      this.store.listFindings(),
      currentRun.intentId ? this.store.getIntent(currentRun.intentId) : this.store.getIntentForRun(currentRun.id)
    ]);
    return {
      agentId,
      currentRun,
      intent: intent ?? null,
      permissions: configuredVsObserved(permissions ?? {}, events),
      recentActivity: events.slice(-20),
      currentFindings: findings.filter(
        (finding) => finding.runId === currentRun.id && ["open", "resolving", "re_reviewing"].includes(finding.status)
      ),
      riskSummary: riskSummary(findings.filter((finding) => finding.runId === currentRun.id && finding.status === "open"))
    };
  }
}

function configuredVsObserved(permissions: PermissionSnapshot, events: AgentEvent[]) {
  const files = events
    .filter((event) => event.category === "filesystem" && event.resource)
    .map((event) => event.resource as string);
  const network = new Set(
    events.filter((event) => event.category === "network" && event.resource).map((event) => event.resource as string)
  );
  const secrets = new Set(
    events
      .filter((event) => event.category === "secret" && event.action === "access" && event.resource)
      .map((event) => event.resource as string)
  );
  const mcpEvents = events.filter((event) => event.category === "mcp" && event.action === "tool_call" && event.resource);
  return {
    filesystem: (permissions.filesystem ?? []).map((permission) => ({
      ...permission,
      used: files.some((file) => within(file, permission.path)),
      observedResources: files.filter((file) => within(file, permission.path))
    })),
    network: (permissions.network ?? []).map((host) => ({ host, allowed: true, contacted: network.has(host) })),
    secrets: (permissions.secrets ?? []).map((name) => ({ name, configured: true, observed: secrets.has(name) })),
    mcpServers: (permissions.mcpServers ?? []).map((server) => {
      const configured = normalizeMcp(server);
      const calls = mcpEvents.filter((event) => event.resource === configured.name || event.resource?.startsWith(`${configured.name}/`));
      return { ...configured, configured: true, used: calls.length > 0, observedTools: calls.map((event) => event.resource) };
    }),
    tools: permissions.tools ?? []
  };
}

function normalizeMcp(server: string | MCPServer): MCPServer {
  return typeof server === "string"
    ? { id: server, name: server, transport: "other", status: "available" }
    : server;
}

function within(resource: string, configured: string): boolean {
  const normalizedResource = resource.replace(/^\/workspace\/?/, "").replace(/\/$/, "");
  const normalizedConfigured = configured.replace(/^\/workspace\/?/, "").replace(/\/$/, "");
  return normalizedResource === normalizedConfigured || normalizedResource.startsWith(`${normalizedConfigured}/`);
}

function riskSummary(findings: Finding[]) {
  return {
    criticalFindings: findings.filter((finding) => finding.severity === "critical").length,
    highFindings: findings.filter((finding) => finding.severity === "high").length,
    mediumFindings: findings.filter((finding) => finding.severity === "medium").length,
    unexpectedFiles: findings.filter((finding) => finding.type === "spec_drift").length,
    unexpectedNetworkDestinations: findings.filter((finding) => finding.type === "network").length,
    sensitiveFilesChanged: findings.filter((finding) => finding.type === "sensitive_change").length,
    unexpectedDependencies: findings.filter((finding) => finding.type === "dependency").length
  };
}
