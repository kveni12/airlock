import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "../src/projects/projectService.js";
import { JsonStore } from "../src/store/jsonStore.js";

let dir: string;
let file: string;
let service: ProjectService;

const input = {
  name: "billing",
  repoPath: "/repos/billing",
  branch: "main",
  agentKind: "claude_code",
  runtime: "docker",
  scope: {
    folders: [
      { path: "/workspace", access: "none" },
      { path: "/workspace/src/billing", access: "read_write" }
    ],
    hosts: ["api.anthropic.com"],
    secrets: ["ANTHROPIC_API_KEY"],
    mcpServers: ["github"],
    tools: ["filesystem", "shell"]
  }
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "periscope-projects-"));
  file = path.join(dir, "store.json");
  const store = new JsonStore(file);
  await store.init();
  service = new ProjectService(store);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProjectService", () => {
  it("creates a project with its saved scope and persists it across store re-init", async () => {
    const created = await service.create(input);
    expect(created.id).toMatch(/^proj_/);
    expect(created.scope.folders).toHaveLength(2);
    expect(created.scope.secrets).toEqual(["ANTHROPIC_API_KEY"]);

    const reopened = new JsonStore(file);
    await reopened.init();
    const list = await new ProjectService(reopened).list();
    expect(list.map((p) => p.id)).toEqual([created.id]);
    expect(list[0].repoPath).toBe("/repos/billing");
  });

  it("rejects missing fields, unknown runtimes, malformed scopes and non-env-var secret names", async () => {
    await expect(service.create({ repoPath: "/x" })).rejects.toThrow(/name/);
    await expect(service.create({ name: "x" })).rejects.toThrow(/repoPath/);
    await expect(service.create({ ...input, runtime: "firecracker" })).rejects.toThrow(/runtime/);
    await expect(service.create({ ...input, scope: { ...input.scope, folders: [{ path: "src", access: "rw" }] } })).rejects.toThrow(/none, read, or read_write/);
    await expect(service.create({ ...input, scope: { ...input.scope, hosts: "api.example.com" } })).rejects.toThrow(/scope.hosts/);
    await expect(service.create({ ...input, scope: { ...input.scope, secrets: ["my-key"] } })).rejects.toThrow(/environment variable/);
  });

  it("replaces settings on update so cleared fields do not linger, keeping id and timestamps", async () => {
    const created = await service.create(input);
    const { branch: _branch, agentKind: _agent, ...withoutOptionals } = input;
    const updated = await service.update(created.id, { ...withoutOptionals, runtime: "process", scope: { ...input.scope, secrets: [] } });
    expect(updated?.id).toBe(created.id);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.branch).toBeUndefined();
    expect(updated?.agentKind).toBeUndefined();
    expect(updated?.runtime).toBe("process");
    expect(updated?.scope.secrets).toEqual([]);
    expect(await service.update("proj_missing", input)).toBeUndefined();
  });

  it("stamps lastOpenedAt on open and lists most recently opened first", async () => {
    const a = await service.create({ ...input, name: "a" });
    const b = await service.create({ ...input, name: "b" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const opened = await service.open(a.id);
    expect(opened?.lastOpenedAt).toBeDefined();
    const list = await service.list();
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("deletes projects and reports unknown ids", async () => {
    const created = await service.create(input);
    expect(await service.delete(created.id)).toBe(true);
    expect(await service.delete(created.id)).toBe(false);
    expect(await service.list()).toEqual([]);
  });
});
