import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { EventCollector } from "../src/events/eventCollector.js";
import { PolicyEngine } from "../src/policy/policyEngine.js";
import { RuntimeManager } from "../src/runtime/runtimeManager.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { Finding, ResolutionAttempt, Review, RunRecord } from "../src/types.js";

const runPhase2 = process.env.RUN_PHASE2_E2E === "1";

describe.skipIf(!runPhase2)("Periscope Phase 2 governance loop", () => {
  const cleanupPaths: string[] = [];
  afterAll(async () => {
    for (const cleanupPath of cleanupPaths) await rm(cleanupPath, { recursive: true, force: true });
  });

  it("runs intent -> observe -> find -> review -> resolve -> re-review -> approve", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "agentguard-phase2-"));
    cleanupPaths.push(temp);
    const repo = path.join(temp, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify({ name: "phase2-demo", version: "1.0.0", scripts: { test: "node tests/auth.test.js" } }, null, 2)}\n`
    );

    const store = new JsonStore(path.join(temp, "store.json"));
    await store.init();
    const policy = new PolicyEngine(async (runId) => {
      const [run, permissions] = await Promise.all([store.getRun(runId), store.getPermissions(runId)]);
      return run ? { permissions: permissions ?? {}, expectedFiles: run.expectedFiles } : undefined;
    });
    const events = new EventCollector(store, policy);
    const runtime = new RuntimeManager(store, events, {
      defaultProvider: "docker",
      image: "agentguard-runtime:latest",
      workspaceRoot: temp
    });
    const app = await createApp({ store, events, runtime });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        taskId: "task_oauth_phase2",
        agentId: "builder_phase2",
        repo: { path: repo },
        runtime: { provider: "docker", image: "agentguard-runtime:latest" },
        command: [
          "bash",
          "-lc",
          [
            "mkdir -p src/auth tests infra",
            "printf 'export const oauthEnabled = true;\\n' > src/auth/oauth.js",
            "printf 'if (true !== true) throw new Error(\"failed\");\\nconsole.log(\"oauth tests passed\");\\n' > tests/auth.test.js",
            "printf 'production = true\\n' > infra/prod.tf",
            "echo 'AGENTGUARD_EVENT {\"category\":\"agent\",\"action\":\"tool_call\",\"resource\":\"shell\",\"metadata\":{\"command\":\"npm test\"}}'",
            "npm test",
            "echo 'AGENTGUARD_EVENT {\"category\":\"agent\",\"action\":\"tool_result\",\"resource\":\"shell\",\"metadata\":{\"command\":\"npm test\",\"exitCode\":0}}'"
          ].join(" && ")
        ],
        permissions: { tools: ["shell", "npm"] },
        intent: {
          goal: "Add OAuth authentication",
          summary: "Add OAuth implementation and tests without infrastructure changes.",
          plannedChanges: ["Add OAuth module", "Add authentication tests"],
          expectedFiles: ["src/auth/**", "tests/**"],
          expectedDependencies: [],
          expectedNetwork: ["oauth.googleapis.com"],
          expectedMcpServers: [],
          expectedSecrets: ["GOOGLE_CLIENT_SECRET"],
          constraints: ["Do not modify infrastructure"]
        },
        timeoutMs: 60_000
      }
    });
    expect(createResponse.statusCode).toBe(202);
    const { runId } = createResponse.json() as { runId: string };
    const builderRun = await waitForRun(store, runId);
    expect(builderRun.status).toBe("completed");
    expect(builderRun.cleanupWorkspace).toBe(false);

    const finding = await waitForFinding(store, runId, "infra/prod.tf");
    expect(finding.evidence?.eventIds?.length).toBeGreaterThan(0);

    const reviewResponse = await app.inject({ method: "POST", url: `/api/runs/${runId}/review`, payload: {} });
    expect(reviewResponse.statusCode).toBe(201);
    const review = reviewResponse.json() as Review;
    expect(review.filesReviewed).toBe(review.filesTotal);
    expect(review.filesWithFindings).toBeGreaterThan(0);

    const resolveResponse = await app.inject({ method: "POST", url: `/api/findings/${finding.id}/resolve`, payload: {} });
    expect(resolveResponse.statusCode).toBe(202);
    const pendingAttempt = resolveResponse.json() as ResolutionAttempt;
    const attempt = await waitForResolution(store, pendingAttempt.id);
    expect(attempt.status, attempt.failureReason).toBe("resolved");
    expect((await store.getFinding(finding.id))?.status).toBe("resolved");
    expect(attempt.reviewId).toBeTruthy();

    const approveResponse = await app.inject({
      method: "POST",
      url: `/api/reviews/${attempt.reviewId}/approve`,
      payload: { actor: "phase2-test-human", reason: "Resolution verified" }
    });
    expect(approveResponse.statusCode).toBe(200);
    expect((approveResponse.json() as Review).status).toBe("approved");

    const dashboard = (await app.inject({ method: "GET", url: "/api/dashboard/summary" })).json();
    expect(dashboard.riskSummary).toBeTruthy();
    const resolutionRun = attempt.resolutionRunId ? await store.getRun(attempt.resolutionRunId) : undefined;
    expect(resolutionRun?.gitSummary?.files).not.toContain("infra/prod.tf");
    const relatedFindings = (await store.listFindings()).filter(
      (item) =>
        [runId, attempt.resolutionRunId].includes(item.runId) &&
        (item.file === "infra/prod.tf" || item.evidence?.observedResource === "infra/prod.tf")
    );
    expect(relatedFindings.length).toBeGreaterThan(1);
    expect(relatedFindings.every((item) => item.status === "resolved")).toBe(true);
    expect(
      (await store.listFindings()).some((item) => item.runId === attempt.resolutionRunId && item.type === "tests")
    ).toBe(false);
    const approvalEvents = resolutionRun ? await store.getEvents(resolutionRun.id) : [];
    expect(approvalEvents.some((event) => event.action === "review_approved")).toBe(true);

    await app.close();
  }, 180_000);
});

async function waitForRun(store: JsonStore, runId: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const run = await store.getRun(runId);
    if (run && ["completed", "failed", "stopped"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function waitForFinding(store: JsonStore, runId: string, resource: string): Promise<Finding> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const finding = (await store.listFindings()).find(
      (item) => item.runId === runId && item.source === "intent_comparison" && item.evidence?.observedResource === resource
    );
    if (finding) return finding;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for finding ${resource}`);
}

async function waitForResolution(store: JsonStore, id: string): Promise<ResolutionAttempt> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const resolution = await store.getResolution(id);
    if (resolution && ["resolved", "failed"].includes(resolution.status)) return resolution;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for resolution ${id}`);
}
