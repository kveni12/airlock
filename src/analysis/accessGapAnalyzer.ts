import { effectiveFileAccess, hostAllowed, normalizeResource, writeAllowed } from "../policy/policyEngine.js";
import type { AgentIntentDraft, PermissionSnapshot } from "../types.js";

export type AccessGapKind = "filesystem_write" | "network" | "secret" | "mcp_server" | "tool";

export interface AccessGap {
  kind: AccessGapKind;
  /** The resource the intent declares it needs, as written by the agent. */
  requested: string;
  /** Plain-language explanation for the human deciding whether to grant it. */
  reason: string;
  /** Whether the current permission snapshot would actively prevent this (vs. only flag it after the fact). */
  enforcement: "blocked" | "flagged" | "not_enforced";
}

export interface AccessGapReport {
  gaps: AccessGap[];
  /** Verification of the requested items is agent-reported: the intent itself is the agent's claim. */
  verification: "agent_reported";
}

/**
 * Compares what a declared intent says it needs against what a permission snapshot grants.
 * Deterministic and pre-execution: it lets a human widen scope on purpose instead of discovering
 * out-of-scope behaviour only after the run.
 */
export function analyzeAccessGaps(intent: AgentIntentDraft, permissions: PermissionSnapshot): AccessGapReport {
  const gaps: AccessGap[] = [];
  const filesystem = permissions.filesystem ?? [];
  const writable = filesystem.filter((permission) => permission.access === "read_write");

  for (const expected of intent.expectedFiles ?? []) {
    const target = normalizeResource(expected.replace(/\/?\*\*?$/, "")) ?? "";
    if (!writeAllowed(target, filesystem)) {
      gaps.push({
        kind: "filesystem_write",
        requested: expected,
        reason: `The plan expects to change ${expected}, but its effective access is ${effectiveFileAccess(target, filesystem) === "none" ? "no access" : "read only"}.${writable.length ? " Writable paths: " + writable.map((p) => p.path).join(", ") + "." : ""}`,
        enforcement: "flagged"
      });
    }
  }

  for (const host of intent.expectedNetwork ?? []) {
    if (!hostAllowed(host, permissions.network ?? [])) {
      gaps.push({ kind: "network", requested: host, reason: `The plan expects to reach ${host}, which is not on the network allowlist.`, enforcement: "blocked" });
    }
  }

  const secrets = new Set(permissions.secrets ?? []);
  for (const secret of intent.expectedSecrets ?? []) {
    if (!secrets.has(secret)) {
      gaps.push({ kind: "secret", requested: secret, reason: `The plan expects the secret ${secret}, which will not be injected into the sandbox.`, enforcement: "blocked" });
    }
  }

  const mcp = new Set((permissions.mcpServers ?? []).map((server) => (typeof server === "string" ? server : server.name)));
  for (const server of intent.expectedMcpServers ?? []) {
    if (!mcp.has(server)) {
      gaps.push({ kind: "mcp_server", requested: server, reason: `The plan expects the MCP server ${server}, which is not in the granted list.`, enforcement: "not_enforced" });
    }
  }

  const tools = permissions.tools ?? [];
  if (tools.length) {
    for (const tool of intent.expectedTools ?? []) {
      if (!tools.includes(tool)) {
        gaps.push({ kind: "tool", requested: tool, reason: `The plan expects the tool ${tool}, which is not in the granted list.`, enforcement: "not_enforced" });
      }
    }
  }

  return { gaps, verification: "agent_reported" };
}
