import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { runIdFromLimaName } from "../src/runtime/limaProvider.js";
import { RuntimeManager } from "../src/runtime/runtimeManager.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { RunRecord } from "../src/types.js";

describe("RuntimeManager.recover", () => {
  let directory: string;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("fails runs stranded by a previous backend process and deletes their temp workspaces", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "recover-"));
    const store = new JsonStore(path.join(directory, "store.json"));
    await store.init();
    const events = new EventCollector(store, new PolicyEngine(async () => undefined));
    const stale = path.join(directory, "ws-stale");
    const kept = path.join(directory, "ws-kept");
    await Promise.all([writeFile(`${stale}`, ""), writeFile(`${kept}`, "")]);

    const base = {
      taskId: "t",
      agentId: "a",
      createdAt: new Date().toISOString(),
      repoPath: directory,
      command: ["true"],
      runtimeProvider: "process" as const,
      environmentKeys: [],
      timeoutMs: 1000,
      expectedFiles: []
    };
    await store.createRun({ ...base, id: "run_stale", status: "running", workspacePath: stale, cleanupWorkspace: true } as RunRecord, {});
    await store.createRun({ ...base, id: "run_kept", status: "starting", workspacePath: kept, cleanupWorkspace: false } as RunRecord, {});
    await store.createRun({ ...base, id: "run_done", status: "completed", cleanupWorkspace: true } as RunRecord, {});

    const manager = new RuntimeManager(store, events, { defaultProvider: "process" });
    const result = await manager.recover();

    expect(result.failedRuns.sort()).toEqual(["run_kept", "run_stale"]);
    expect((await store.getRun("run_stale"))?.status).toBe("failed");
    expect((await store.getRun("run_kept"))?.failureReason).toMatch(/restarted/);
    expect((await store.getRun("run_done"))?.status).toBe("completed");
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(kept)).resolves.toBeDefined();
    const runtimeEvents = (await events.getEvents("run_stale")).filter((event) => event.category === "runtime");
    expect(runtimeEvents.map((event) => event.action)).toContain("failed");
  });
});

describe("runIdFromLimaName", () => {
  it("maps per-run VM names back to run ids and ignores base VMs", () => {
    expect(runIdFromLimaName("agentguard-run-0cacf00d")).toBe("run_0cacf00d");
    expect(runIdFromLimaName("agentguard-base")).toBeUndefined();
    expect(runIdFromLimaName("agentguard-claude-code")).toBeUndefined();
  });
});
