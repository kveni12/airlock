import path from "node:path";
import type { AgentEvent, EventInput, PermissionSnapshot } from "../types.js";

export const DEFAULT_SENSITIVE_PATTERNS = [
  ".env",
  ".env.*",
  "Dockerfile",
  "docker-compose.*",
  ".github/workflows/**",
  "terraform/**",
  "infra/**",
  "auth/**",
  "config/**",
  "*.pem",
  "*.key"
];

export interface PolicyContext {
  permissions: PermissionSnapshot;
  expectedFiles?: string[];
  sensitivePatterns?: string[];
}

export class PolicyEngine {
  constructor(private readonly contextForRun: (runId: string) => Promise<PolicyContext | undefined>) {}

  async evaluate(event: AgentEvent): Promise<EventInput[]> {
    if (event.category === "policy") return [];

    const context = await this.contextForRun(event.runId);
    if (!context) return [];

    const violations: EventInput[] = [];
    if (event.category === "filesystem" || event.category === "git") {
      const resource = normalizeResource(event.resource);
      if (resource && isModificationAction(event.action)) {
        if (context.expectedFiles?.length && !matchesAny(resource, context.expectedFiles)) {
          violations.push(this.violation(event, "unexpected_file_change", resource, "Agent modified a file outside the expected file set."));
        }

        if (matchesAny(resource, context.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS)) {
          violations.push(this.violation(event, "sensitive_file_change", resource, "Agent modified a potentially sensitive file."));
        }

        const allowedFiles = context.permissions.filesystem ?? [];
        if (allowedFiles.length && !allowedFiles.some((permission) => pathWithinPermission(resource, permission.path))) {
          violations.push(this.violation(event, "permission_scope", resource, "Agent touched a path outside its declared filesystem scope."));
        }
      }
    }

    if (event.category === "network" && event.resource) {
      const allowed = context.permissions.network ?? [];
      if (allowed.length && !hostAllowed(event.resource, allowed)) {
        violations.push(this.violation(event, "network_scope", event.resource, "Agent attempted to contact a destination outside its declared network scope."));
      }
    }

    return violations;
  }

  private violation(source: AgentEvent, rule: string, resource: string, message: string): EventInput {
    return {
      runId: source.runId,
      taskId: source.taskId,
      agentId: source.agentId,
      category: "policy",
      action: "violation",
      resource,
      allowed: false,
      severity: "high",
      metadata: {
        rule,
        message,
        sourceEventId: source.id,
        sourceCategory: source.category,
        sourceAction: source.action
      }
    };
  }
}

export function matchesAny(resource: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = normalizeResource(pattern);
    return normalized ? globToRegExp(normalized).test(resource) : false;
  });
}

function isModificationAction(action: string): boolean {
  return ["create", "write", "delete", "file_changed"].includes(action);
}

function normalizeResource(resource?: string): string | undefined {
  if (!resource) return undefined;
  return resource.replace(/^\/workspace\//, "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathWithinPermission(resource: string, permissionPath: string): boolean {
  const normalizedPermission = normalizeResource(permissionPath) ?? permissionPath;
  if (["/workspace", "/workspace/", ".", ""].includes(normalizedPermission)) return true;
  return resource === normalizedPermission || resource.startsWith(`${normalizedPermission.replace(/\/$/, "")}/`);
}

function hostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}
