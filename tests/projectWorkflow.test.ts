import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { AuthService } from "../src/auth/authService.js";
import { signIn } from "./testAuth.js";

it("previews permissions, saves a project, and preserves its human request on a linked session", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "project-workflow-"));
  const repoPath = path.join(temp, "repo");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  const store = new JsonStore(path.join(temp, "store.json"));
  const auth = new AuthService(store);
  const app = await createApp({ store, auth });
  try {
    const headers = { cookie: await signIn(app, auth) };
    const description = "Fix src. Do not change infrastructure.";
    const suggestion = await app.inject({ method: "POST", url: "/api/projects/suggest-permissions", headers, payload: { repoPath, description } });
    expect(suggestion.statusCode).toBe(200);
    const scope = suggestion.json().scope;
    const created = await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "Workflow test", repoPath, runtime: "docker", agentKind: "codex", humanIntent: description, scope } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.humanIntent).toBe(description);
    expect((await app.inject({ method: "POST", url: "/api/projects/validate-local", headers, payload: project })).statusCode).toBe(200);
    const request = (await app.inject({ method: "POST", url: "/api/requests", headers, payload: { taskId: "workflow", rawPrompt: project.humanIntent } })).json().request;
    const start = await app.inject({ method: "POST", url: "/api/runs", headers, payload: { taskId: "workflow", agentId: "workflow-test", projectId: project.id, requestId: request.id, repo: { path: repoPath }, permissions: { filesystem: scope.folders, network: [], secrets: [] }, runtime: { provider: "process" }, command: ["/bin/echo", "workflow test"], cleanupWorkspace: true } });
    expect(start.statusCode).toBe(202);
    const runId = start.json().runId;
    for (let i = 0; i < 100; i++) {
      const run = await store.getRun(runId);
      if (run && ["completed", "failed", "stopped"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await app.inject({ method: "PUT", url: `/api/projects/${project.id}`, headers, payload: { ...project, humanIntent: "A later task" } });
    expect((await store.getRequest(request.id))?.rawPrompt).toBe(description);
    expect((await store.getRun(runId))?.projectId).toBe(project.id);
    expect((await store.getRun(runId))?.requestId).toBe(request.id);
    expect((await store.getRun(runId))?.status).toBe("completed");
  } finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
});
