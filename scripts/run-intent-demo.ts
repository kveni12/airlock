/**
 * Deterministic Intent Observability demo.
 *
 * Drives the real AgentGuard HTTP API (in-process via Fastify inject) through:
 *   human request -> read-only planner intent -> request/intent alignment -> execution
 *   -> telemetry -> intent/behavior findings -> review -> resolution -> re-review -> approval
 *
 * Runtime provider defaults to `process` so it works without Lima/Docker. Set
 * AGENTGUARD_RUNTIME_PROVIDER=lima|docker to run inside a real sandbox (requires the demo
 * agent scripts to be installed there, see scripts/setup-vm-runtime.sh / runtime/Dockerfile).
 */
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store/jsonStore.js";
import type {
  AgentIntent,
  AlignmentSummary,
  Finding,
  HumanRequest,
  RequestAnalysis,
  ResolutionAttempt,
  ResultSummary,
  Review,
  RunRecord,
  TimelineEntry
} from "../src/types.js";
import type { ObservedBehavior } from "../src/analysis/observedBehavior.js";

const HUMAN_PROMPT = [
  "Fix the login/session bug and add a regression test.",
  "Do not modify database or infrastructure configuration.",
  "Do not add external dependencies."
].join("\n");

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const provider = (process.env.AGENTGUARD_RUNTIME_PROVIDER ?? "process") as "lima" | "docker" | "process";
const plannerCommand = provider === "process" ? [path.join(repoRoot, "runtime/intent-demo-planner.sh")] : ["agentguard-intent-demo-planner"];
const builderCommand = provider === "process" ? [path.join(repoRoot, "runtime/intent-demo-builder.sh")] : ["agentguard-intent-demo-builder"];

async function api<T>(app: FastifyInstance, method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await app.inject({ method, url, payload: body as Record<string, unknown> | undefined });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} -> ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

async function waitForRun(app: FastifyInstance, runId: string): Promise<RunRecord> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const run = await api<RunRecord>(app, "GET", `/api/runs/${runId}`);
    if (["completed", "failed", "stopped"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function waitForResolution(app: FastifyInstance, id: string): Promise<ResolutionAttempt> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const attempt = await api<ResolutionAttempt>(app, "GET", `/api/resolutions/${id}`);
    if (["resolved", "failed"].includes(attempt.status)) return attempt;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for resolution ${id}`);
}

function heading(title: string): void {
  console.log(`\n${"─".repeat(60)}\n${title}\n${"─".repeat(60)}`);
}

function mark(status: string): string {
  return status === "aligned" ? "✓" : status === "warning" ? "⚠" : "✗";
}

async function main(): Promise<void> {
  const storePath = process.env.AGENTGUARD_STORE_PATH ?? path.join(await mkdtemp(path.join(os.tmpdir(), "agentguard-intent-demo-")), "store.json");
  const app = await createApp({ store: new JsonStore(storePath) });
  await app.ready();
  const taskId = `intent-demo-${Date.now()}`;
  const runtime = { provider };
  const repo = { path: path.join(repoRoot, "fixtures/intent-demo-repo") };
  const permissions = {
    filesystem: [{ path: "/workspace", access: "read_write" }],
    network: [],
    secrets: [],
    mcpServers: [],
    tools: ["filesystem", "shell"]
  };

  try {
    heading("1. HUMAN REQUEST");
    const { request, analysis } = await api<{ request: HumanRequest; analysis: RequestAnalysis }>(app, "POST", "/api/requests", {
      taskId,
      rawPrompt: HUMAN_PROMPT
    });
    console.log(request.rawPrompt);
    console.log(`objectives=${analysis.objectives.length} explicitConstraints=${analysis.explicitConstraints.length} forbidden=${JSON.stringify(analysis.explicitlyForbiddenResources)}`);

    heading("2. AGENT INTENT (read-only planning run)");
    const intent = await api<AgentIntent>(app, "POST", "/api/intents/generate", {
      taskId,
      agentId: "demo-planner",
      requestId: request.id,
      repo,
      command: plannerCommand,
      runtime,
      timeoutMs: 60_000
    });
    for (const action of intent.plannedChanges) console.log(`- ${action}`);
    console.log(`planningRunId=${intent.planningRunId} alignment=${intent.alignment?.status}`);
    if (intent.alignment?.status !== "aligned") throw new Error(`Expected aligned request→intent, got ${intent.alignment?.status}`);

    heading("3. EXECUTION (builder run)");
    const { runId } = await api<{ runId: string }>(app, "POST", "/api/runs", {
      taskId,
      agentId: "demo-builder",
      repo,
      command: builderCommand,
      permissions,
      runtime,
      intentId: intent.id,
      timeoutMs: 60_000,
      cleanupWorkspace: false
    });
    const run = await waitForRun(app, runId);
    console.log(`run=${run.id} status=${run.status} exitCode=${run.exitCode}`);
    if (run.status !== "completed") throw new Error(`Builder run did not complete: ${run.failureReason}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    heading("4. OBSERVED BEHAVIOR");
    const behavior = await api<ObservedBehavior>(app, "GET", `/api/runs/${runId}/behavior`);
    console.log(`modified: ${behavior.files.modified.map((f) => f.name).join(", ")}`);
    console.log(`created:  ${behavior.files.created.map((f) => f.name).join(", ") || "(none)"}`);
    console.log(`reads:    ${behavior.files.read.status} (${behavior.files.read.reason})`);
    console.log(`tests:    ${behavior.tests.map((t) => `${t.name} passed=${t.passed} [${t.verification}]`).join(", ") || "(none)"}`);
    console.log(`tools:    ${behavior.tools.map((t) => `${t.name} [${t.verification}]`).join(", ") || "(none)"}`);
    console.log(`deps+:    ${behavior.dependenciesAdded.map((d) => d.name).join(", ") || "(none)"}`);
    console.log(`coverage: ${JSON.stringify(behavior.coverage)}`);

    heading("5. ALIGNMENT");
    const alignment = await api<AlignmentSummary>(app, "GET", `/api/runs/${runId}/alignment`);
    console.log(`${mark(alignment.requestToIntent.status)} Request → Intent   ${alignment.requestToIntent.status}  ${alignment.requestToIntent.detail}`);
    console.log(`${mark(alignment.intentToBehavior.status)} Intent → Behavior  ${alignment.intentToBehavior.status}  ${alignment.intentToBehavior.detail}`);
    console.log(`counts: ${JSON.stringify(alignment.counts)}`);
    const { findings } = await api<{ findings: Finding[] }>(app, "GET", `/api/findings?runId=${runId}&status=open`);
    for (const finding of findings) {
      console.log(`  [${finding.severity}] ${finding.title} — ${finding.file ?? finding.evidence?.observedResource ?? ""} (verification=${finding.evidence?.verification}, events=${finding.evidence?.eventIds?.length ?? 0})`);
    }
    const infra = findings.find((f) => f.file === "infra/prod.tf");
    const dependency = findings.find((f) => f.type === "dependency" && f.evidence?.observedResource === "axios");
    if (!infra || !dependency) throw new Error("Expected infrastructure and dependency drift findings from the real pipeline");

    heading("6. REVIEW");
    const review = await api<Review>(app, "POST", `/api/runs/${runId}/review`, {});
    console.log(`review=${review.id} status=${review.status} files=${review.fileReviews.length}`);

    heading("7. RESOLUTION + RE-REVIEW");
    for (const finding of [infra, dependency]) {
      const attempt = await api<ResolutionAttempt>(app, "POST", `/api/findings/${finding.id}/resolve`, {});
      const done = await waitForResolution(app, attempt.id);
      console.log(`${finding.title}: resolution=${done.status} reReview=${done.reReviewResult?.passed ?? "n/a"}`);
      if (done.status !== "resolved") throw new Error(`Resolution failed: ${done.failureReason ?? "unknown"}`);
      if (done.reviewId) {
        await api(app, "POST", `/api/reviews/${done.reviewId}/approve`, { actor: "demo-human", reason: "Drift reverted and verified." });
      }
    }

    heading("8. RESULT");
    const finalAlignment = await api<AlignmentSummary>(app, "GET", `/api/runs/${runId}/alignment`);
    const result = await api<ResultSummary>(app, "GET", `/api/runs/${runId}/result`);
    console.log(`${mark(finalAlignment.requestToIntent.status)} Request → Intent    ${finalAlignment.requestToIntent.status}`);
    console.log(`${mark(finalAlignment.intentToBehavior.status)} Intent → Behavior   ${finalAlignment.intentToBehavior.status} (${finalAlignment.intentToBehavior.detail})`);
    console.log(`${mark(finalAlignment.behaviorToResult?.status ?? "warning")} Behavior → Result   ${finalAlignment.behaviorToResult?.status ?? "n/a"}`);
    console.log(`findings: total=${result.findings.total} open=${result.findings.open} resolved=${result.findings.resolved}`);
    const { findings: stillOpen } = await api<{ findings: Finding[] }>(app, "GET", `/api/findings?runId=${runId}&status=open`);
    for (const finding of stillOpen) console.log(`  still open: [${finding.severity}] ${finding.title} — ${finding.file ?? ""}`);
    console.log(`files changed: ${result.filesChanged.join(", ")} (+${result.insertions}/-${result.deletions})`);

    heading("9. TIMELINE");
    const { entries } = await api<{ entries: TimelineEntry[] }>(app, "GET", `/api/runs/${runId}/timeline`);
    for (const entry of entries) {
      if (["filesystem", "policy", "process"].includes(entry.kind) && !/session\.js|prod\.tf|package\.json|exit/.test(entry.detail ?? "")) continue;
      const detail = entry.detail ? `: ${entry.detail.replace(/\s+/g, " ").slice(0, 70)}` : "";
      console.log(`${entry.timestamp.slice(11, 23)} ${entry.kind.padEnd(16)} ${entry.title}${detail}${entry.verification ? ` [${entry.verification}]` : ""}`);
    }
    console.log(`\nStore: ${storePath}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
