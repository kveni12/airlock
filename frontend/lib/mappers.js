export const activeStatuses = new Set(["pending", "starting", "running", "stopping"]);

export function isRunActive(status) {
  return activeStatuses.has(status);
}

export function statusLabel(status) {
  return String(status).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function summarizeSnapshot(snapshot) {
  const events = Object.values(snapshot.eventsByRun).flat();
  return {
    activeAgents: new Set(snapshot.runs.filter((run) => isRunActive(run.status)).map((run) => run.agentId)).size,
    policyAlerts: events.filter((event) => event.category === "policy").length,
    filesChanged: snapshot.runs.reduce((total, run) => total + (run.gitSummary?.filesChanged ?? 0), 0),
    recordedEvents: events.length
  };
}

export function permissionCount(permissions) {
  return (permissions.filesystem?.length ?? 0) + (permissions.network?.length ?? 0) + (permissions.secrets?.length ?? 0) + (permissions.mcpServers?.length ?? 0) + (permissions.tools?.length ?? 0);
}
