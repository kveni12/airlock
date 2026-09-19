import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RequestService } from "../src/request/requestService.js";
import { JsonStore } from "../src/store/jsonStore.js";

describe("RequestService", () => {
  it("persists the raw prompt verbatim alongside a separate analysis", async () => {
    const harness = await createHarness();
    const rawPrompt = "Fix the login bug.\n\nDon't modify the database.  ";
    const { request, analysis } = await harness.service.create({
      taskId: "task_login",
      rawPrompt,
      explicitConstraints: ["Do not modify the database"],
      context: { attachments: ["issue-42"], metadata: { source: "jira" } }
    });

    expect(request.rawPrompt).toBe(rawPrompt);
    expect(request.explicitConstraints).toEqual(["Do not modify the database"]);
    expect(request.runId).toBeUndefined();
    expect(await harness.store.getRequest(request.id)).toEqual(request);
    expect(await harness.service.getAnalysis(request.id)).toEqual(analysis);
    expect(analysis.requestId).toBe(request.id);
    expect(Object.isFrozen(request)).toBe(true);
    await harness.cleanup();
  });

  it("only allows attaching a run, never rewriting the prompt", async () => {
    const harness = await createHarness();
    const { request } = await harness.service.create({ taskId: "task_login", rawPrompt: "Fix the login bug." });
    await harness.service.attachToRun(request.id, "run_1");
    const stored = await harness.store.getRequest(request.id);
    expect(stored?.runId).toBe("run_1");
    expect(stored?.rawPrompt).toBe("Fix the login bug.");
    await expect(harness.service.attachToRun(request.id, "run_2")).rejects.toThrow("already attached");
    expect(await harness.store.getRequestForRun("run_1")).toEqual(stored);
    await harness.cleanup();
  });

  it("rejects empty prompts and malformed drafts", async () => {
    const harness = await createHarness();
    await expect(harness.service.create({ taskId: "task", rawPrompt: "   " })).rejects.toThrow("rawPrompt");
    await expect(harness.service.create({ taskId: "", rawPrompt: "Fix" })).rejects.toThrow("taskId");
    await expect(
      harness.service.create({ taskId: "task", rawPrompt: "Fix", explicitConstraints: [1] as unknown as string[] })
    ).rejects.toThrow("explicitConstraints");
    expect(await harness.store.listRequests()).toEqual([]);
    await harness.cleanup();
  });
});

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-request-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  return { store, service: new RequestService(store), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
