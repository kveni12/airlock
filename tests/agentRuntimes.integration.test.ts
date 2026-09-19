import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { RuntimeManager } from "../src/runtime/runtimeManager.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { AgentKind } from "../src/types.js";

const runAgentSmokeTests = process.env.RUN_AGENT_SMOKE_TESTS === "1";

const agents: Array<{ kind: AgentKind; command: string[]; expectedBase: string }> = [
  { kind: "codex", command: ["codex", "--version"], expectedBase: "agentguard-codex-base" },
  { kind: "claude_code", command: ["claude", "--version"], expectedBase: "agentguard-claude-code-base" },
  { kind: "cursor", command: ["agent", "--version"], expectedBase: "agentguard-cursor-base" },
  {
    kind: "devin",
    command: ["bash", "-lc", "command -v devin-agentguard-bridge >/dev/null"],
    expectedBase: "agentguard-devin-base"
  }
];

describe.skipIf(!runAgentSmokeTests)("coding-agent VM runtimes", () => {
  it("launches every built-in agent profile from its default VM base", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "agentguard-agent-runtimes-"));
    const repo = path.join(temp, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "agent runtime smoke test\n");

    const store = new JsonStore(path.join(temp, "store.json"));
    await store.init();
    const events = new EventCollector(store, new PolicyEngine(async () => ({ permissions: {} })));
    const runtime = new RuntimeManager(store, events, { defaultProvider: "lima" });

    for (const agent of agents) {
      const run = await runtime.createRun({
        taskId: `task_${agent.kind}`,
        agentId: `agent_${agent.kind}`,
        repo: { path: repo },
        agent: { kind: agent.kind, command: agent.command },
        timeoutMs: 120_000
      });

      const completed = await waitForCompletion(store, run.id);
      expect(completed.status, completed.failureReason).toBe("completed");
      expect(completed.runtimeBaseVm).toBe(agent.expectedBase);
      expect(completed.exitCode).toBe(0);
    }

    await rm(temp, { recursive: true, force: true });
  }, 240_000);
});

async function waitForCompletion(store: JsonStore, runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await store.getRun(runId);
    if (run && ["completed", "failed", "stopped"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${runId}`);
}
