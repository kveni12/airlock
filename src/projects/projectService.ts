import type { JsonStore } from "../store/jsonStore.js";
import type { FilePermission, Project, ProjectInput, ProjectScope, RuntimeProviderKind } from "../types.js";
import { createId } from "../utils/id.js";

const RUNTIMES: RuntimeProviderKind[] = ["docker", "lima", "process"];

export const DEFAULT_PROJECT_SCOPE: ProjectScope = {
  folders: [{ path: "/workspace", access: "read" }],
  hosts: [],
  secrets: [],
  mcpServers: [],
  tools: ["filesystem", "shell"]
};

/** Saved per-repo sandbox settings (runtime, agent, files R/RW, network, secrets, MCP, tools). */
export class ProjectService {
  constructor(private readonly store: JsonStore) {}

  list(): Promise<Project[]> {
    return this.store.listProjects().then((projects) =>
      [...projects].sort((a, b) => (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt))
    );
  }

  get(id: string): Promise<Project | undefined> {
    return this.store.getProject(id);
  }

  async create(input: unknown): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = { id: createId("proj"), ...validateProjectInput(input), createdAt: now, updatedAt: now };
    await this.store.createProject(project);
    return project;
  }

  async update(id: string, input: unknown): Promise<Project | undefined> {
    const existing = await this.store.getProject(id);
    if (!existing) return undefined;
    const next = validateProjectInput(input);
    const replaced: Project = { id: existing.id, createdAt: existing.createdAt, ...(existing.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}), ...next, updatedAt: new Date().toISOString() };
    await this.store.replaceProject(replaced);
    return replaced;
  }

  /** Marks the project as opened so the list surfaces recent projects first. */
  async open(id: string): Promise<Project | undefined> {
    return this.store.updateProject(id, { lastOpenedAt: new Date().toISOString() });
  }

  delete(id: string): Promise<boolean> {
    return this.store.deleteProject(id);
  }
}

export function validateProjectInput(value: unknown): ProjectInput {
  if (!isRecord(value)) throw new Error("Project must be an object");
  const name = requiredString(value.name, "name");
  const repoPath = requiredString(value.repoPath, "repoPath");
  const runtime = value.runtime ?? "docker";
  if (!RUNTIMES.includes(runtime as RuntimeProviderKind)) throw new Error(`runtime must be one of ${RUNTIMES.join(", ")}`);
  const scope = validateScope(value.scope ?? DEFAULT_PROJECT_SCOPE);
  return {
    name,
    repoPath,
    ...(optionalString(value.branch, "branch") ? { branch: optionalString(value.branch, "branch") } : {}),
    ...(optionalString(value.agentKind, "agentKind") ? { agentKind: optionalString(value.agentKind, "agentKind") } : {}),
    runtime: runtime as RuntimeProviderKind,
    scope,
    ...(optionalString(value.notes, "notes") ? { notes: optionalString(value.notes, "notes") } : {})
  };
}

function validateScope(value: unknown): ProjectScope {
  if (!isRecord(value)) throw new Error("scope must be an object");
  const folders = Array.isArray(value.folders) ? value.folders : DEFAULT_PROJECT_SCOPE.folders;
  return {
    folders: folders.map(validateFolder),
    hosts: stringList(value.hosts, "scope.hosts"),
    secrets: stringList(value.secrets, "scope.secrets").map((name) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`scope.secrets: "${name}" is not an environment variable name`);
      return name;
    }),
    mcpServers: stringList(value.mcpServers, "scope.mcpServers"),
    tools: stringList(value.tools, "scope.tools")
  };
}

function validateFolder(value: unknown): FilePermission {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) throw new Error("scope.folders entries need a path");
  if (value.access !== "read" && value.access !== "read_write") throw new Error(`scope.folders: access for ${value.path} must be read or read_write`);
  return { path: value.path.trim(), access: value.access };
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a list of strings`);
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
