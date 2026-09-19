import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { RuntimeManager } from "../src/runtime/runtimeManager.js";
import { JsonStore } from "../src/store/jsonStore.js";

const runVmTests = process.env.RUN_VM_TESTS === "1";

describe.skipIf(!runVmTests)("RuntimeManager Lima VM integration", () => {
  it("runs a command in a disposable VM and records telemetry", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "agentguard-vm-runtime-"));
    const repo = path.join(temp, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.txt"), "before\n");

    const store = new JsonStore(path.join(temp, "store.json"));
    await store.init();
    const policy = new PolicyEngine(async (runId) => {
      const run = await store.getRun(runId);
      return {
        permissions: { filesystem: [{ path: "/workspace/src", access: "read_write" }] },
        expectedFiles: run?.expectedFiles
      };
    });
    const events = new EventCollector(store, policy);
    const runtime = new RuntimeManager(store, events, { defaultProvider: "lima", baseVm: "agentguard-base" });

    const run = await runtime.createRun({
      taskId: "task_vm_runtime",
      agentId: "agent_vm_runtime",
      repo: { path: repo },
      command: [
        "bash",
        "-lc",
        "echo plain-output && echo 'AGENTGUARD_EVENT {\"category\":\"agent\",\"action\":\"tool_call\",\"resource\":\"shell\"}' && echo after >> src/app.txt && touch src/new.txt"
      ],
      permissions: { filesystem: [{ path: "/workspace/src", access: "read_write" }], tools: ["shell"] },
      expectedFiles: ["src/app.txt", "src/new.txt"],
      timeoutMs: 120_000,
      runtime: { provider: "lima", baseVm: "agentguard-base" }
    });

    let status = "starting";
    for (let i = 0; i < 240; i += 1) {
      status = (await store.getRun(run.id))?.status ?? "missing";
      if (["completed", "failed", "stopped"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const recordedEvents = await events.getEvents(run.id);
    expect(status).toBe("completed");
    expect(recordedEvents.some((event) => event.category === "filesystem")).toBe(true);
    expect(recordedEvents.some((event) => event.category === "git" && event.action === "file_changed")).toBe(true);
    expect(recordedEvents.some((event) => event.category === "process" && event.action === "output")).toBe(true);
    expect(recordedEvents.some((event) => event.category === "agent" && event.action === "tool_call")).toBe(true);
    expect((await store.getRun(run.id))?.runtimeProvider).toBe("lima");

    await rm(temp, { recursive: true, force: true });
  }, 150_000);
});
