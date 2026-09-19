import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type { ObservedBehavior } from "../src/analysis/observedBehavior.js";
import type {
  AgentEvent,
  AgentIntent,
  AlignmentSummary,
  Finding,
  HumanRequest,
  ResolutionAttempt,
  ResultSummary,
  Review,
  RunRecord,
  TimelineEntry
} from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "fixtures/intent-demo-repo");
const planner = path.join(repoRoot, "runtime/intent-demo-planner.sh");
const builder = path.join(repoRoot, "runtime/intent-demo-builder.sh");
const runtime = { provider: "process" as const };

const PROMPT =
  "Fix the login/session bug and add a regression test.\nDo not modify database or infrastructure configuration.\nDo not add external dependencies.";

async function api<T>(app: FastifyInstance, method: "GET" | "POST", url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await app.inject({ method, url, payload: body });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} -> ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out polling");
}

describe("intent observability end-to-end (process runtime)", () => {
  let temp: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "agentguard-intent-e2e-"));
    app = await createApp({ store: new JsonStore(path.join(temp, "store.json")) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });

  it("runs request -> planner intent -> alignment -> execution -> findings -> review -> resolution -> approval", async () => {
    const taskId = "e2e-intent";
    const { request } = await api<{ request: HumanRequest }>(app, "POST", "/api/requests", { taskId, rawPrompt: PROMPT });
    expect(request.rawPrompt).toBe(PROMPT);

    const intent = await api<AgentIntent>(app, "POST", "/api/intents/generate", {
      taskId,
      agentId: "planner",
      requestId: request.id,
      repo: { path: fixture },
      command: [planner],
      runtime
    });
    expect(intent.planningRunId).toBeDefined();
    const plannerRun = await api<RunRecord>(app, "GET", `/api/runs/${intent.planningRunId}`);
    expect(plannerRun.purpose).toBe("planner");
    expect(plannerRun.workspaceAccess).toBe("read_only");
    expect(plannerRun.status).toBe("completed");
    expect(intent.alignment?.status).toBe("aligned");
    expect(intent.plannedChanges).toHaveLength(4);

    const { runId } = await api<{ runId: string }>(app, "POST", "/api/runs", {
      taskId,
      agentId: "builder",
      repo: { path: fixture },
      command: [builder],
      permissions: { filesystem: [{ path: "/workspace", access: "read_write" }], tools: ["filesystem", "shell"] },
      runtime,
      intentId: intent.id,
      cleanupWorkspace: false
    });
    const run = await poll(() => api<RunRecord>(app, "GET", `/api/runs/${runId}`), (r) => ["completed", "failed", "stopped"].includes(r.status));
    expect(run.status).toBe("completed");
    expect(run.requestId).toBe(request.id);
    expect(run.intentId).toBe(intent.id);
    expect(plannerRun.createdAt <= run.createdAt).toBe(true);

    const { findings } = await poll(
      () => api<{ findings: Finding[] }>(app, "GET", `/api/findings?runId=${runId}&source=intent_comparison`),
      (r) => r.findings.length >= 3
    );
    const infra = findings.find((f) => f.type === "spec_drift" && f.file === "infra/prod.tf");
    const dependency = findings.find((f) => f.type === "dependency" && f.evidence?.observedResource === "axios");
    expect(infra?.evidence?.verification).toBe("independent");
    expect(infra?.evidence?.intentId).toBe(intent.id);
    expect(infra?.evidence?.requestId).toBe(request.id);
    expect(dependency?.file).toBe("package.json");
    expect(findings.some((f) => f.file === "src/auth/session.js")).toBe(false);

    const behavior = await api<ObservedBehavior>(app, "GET", `/api/runs/${runId}/behavior`);
    expect(behavior.files.modified.map((f) => f.name).sort()).toEqual(["infra/prod.tf", "package.json", "src/auth/session.js", "tests/auth/session.test.js"]);
    expect(behavior.files.read.status).toBe("unavailable");
    expect(behavior.dependenciesAdded.map((d) => d.name)).toEqual(["axios"]);
    expect(behavior.tests.some((t) => t.name === "npm test" && t.verification === "agent_reported")).toBe(true);
    expect(behavior.coverage.filesystemWrites).toBe("independent");
    expect(behavior.coverage.shellCommands).toBe("agent_reported");

    const alignment = await api<AlignmentSummary>(app, "GET", `/api/runs/${runId}/alignment`);
    expect(alignment.requestToIntent.status).toBe("aligned");
    expect(alignment.intentToBehavior.status).toBe("conflict");
    expect(alignment.counts.undeclaredFiles).toBe(2);
    expect(alignment.counts.undeclaredDependencies).toBe(1);

    const review = await api<Review>(app, "POST", `/api/runs/${runId}/review`, {});
    expect(review.fileReviews).toHaveLength(4);

    for (const finding of [infra!, dependency!]) {
      const attempt = await api<ResolutionAttempt>(app, "POST", `/api/findings/${finding.id}/resolve`, {});
      const done = await poll(() => api<ResolutionAttempt>(app, "GET", `/api/resolutions/${attempt.id}`), (a) => a.status === "resolved" || a.status === "failed");
      expect(done.status).toBe("resolved");
      expect(done.reReviewResult?.passed).toBe(true);
      await api(app, "POST", `/api/reviews/${done.reviewId}/approve`, { actor: "human" });
    }

    const result = await api<ResultSummary>(app, "GET", `/api/runs/${runId}/result`);
    expect(result.findings.open).toBe(0);
    expect(result.dependenciesChanged.map((d) => d.name)).toEqual(["axios"]);
    const finalAlignment = await api<AlignmentSummary>(app, "GET", `/api/runs/${runId}/alignment`);
    expect(finalAlignment.behaviorToResult?.status).toBe("aligned");

    const { entries } = await api<{ entries: TimelineEntry[] }>(app, "GET", `/api/runs/${runId}/timeline`);
    const kinds = entries.map((e) => e.kind);
    for (const kind of ["human.request", "agent.intent", "intent.analysis", "runtime", "filesystem", "git", "finding.created", "review", "resolution"]) {
      expect(kinds).toContain(kind);
    }
    expect(kinds.indexOf("human.request")).toBeLessThan(kinds.indexOf("agent.intent"));
    expect(kinds.indexOf("agent.intent")).toBeLessThan(kinds.indexOf("runtime"));
    expect(kinds.lastIndexOf("finding.created")).toBeLessThan(kinds.indexOf("resolution"));
    for (let i = 1; i < entries.length; i++) expect(entries[i - 1].timestamp <= entries[i].timestamp).toBe(true);
  });

  it("fails the planning run and emits an explicit event when the planner modifies the workspace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/intents/generate",
      payload: {
        taskId: "e2e-planner-writes",
        agentId: "bad-planner",
        repo: { path: fixture },
        command: ["bash", "-c", "echo drift >> README.md"],
        runtime
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/read-only/);
    const { runs } = await api<{ runs: RunRecord[] }>(app, "GET", "/api/runs");
    const plannerRun = runs.find((r) => r.taskId === "e2e-planner-writes");
    expect(plannerRun?.status).toBe("failed");
    const { events } = await api<{ events: AgentEvent[] }>(app, "GET", `/api/runs/${plannerRun!.id}/events`);
    expect(events.some((e) => e.category === "runtime" && e.action === "planning_workspace_modified")).toBe(true);
  });

  it("records an intent_generation_failed event when the planner emits malformed intent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/intents/generate",
      payload: {
        taskId: "e2e-malformed",
        agentId: "bad-planner",
        repo: { path: fixture },
        command: ["bash", "-c", `echo 'AGENTGUARD_EVENT {"category":"agent","action":"intent","metadata":{"intent":{"goal":""}}}'`],
        runtime
      }
    });
    expect(response.statusCode).toBe(422);
    const { runs } = await api<{ runs: RunRecord[] }>(app, "GET", "/api/runs");
    const plannerRun = runs.find((r) => r.taskId === "e2e-malformed");
    const { events } = await api<{ events: AgentEvent[] }>(app, "GET", `/api/runs/${plannerRun!.id}/events`);
    expect(events.some((e) => e.category === "runtime" && e.action === "intent_generation_failed")).toBe(true);
  });
});
