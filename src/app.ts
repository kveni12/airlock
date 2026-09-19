import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentIntentDraft, CreateRunRequest, FindingSource, FindingStatus, EventSeverity } from "./types.js";
import { JsonStore } from "./store/jsonStore.js";
import { PolicyEngine } from "./policy/policyEngine.js";
import { EventCollector } from "./events/eventCollector.js";
import { RuntimeManager } from "./runtime/runtimeManager.js";
import { IntentService } from "./intent/intentService.js";
import { FindingService } from "./findings/findingService.js";
import { BehaviorAnalysisService } from "./analysis/behaviorAnalyzer.js";
import { ReviewService } from "./review/reviewService.js";
import { ResolutionService, type ResolveFindingRequest } from "./resolution/resolutionService.js";
import { SummaryService } from "./dashboard/summaryService.js";

export interface AppContext {
  store: JsonStore;
  events: EventCollector;
  runtime: RuntimeManager;
  intents: IntentService;
  findings: FindingService;
  analysis: BehaviorAnalysisService;
  reviews: ReviewService;
  resolutions: ResolutionService;
  summaries: SummaryService;
}

export async function createApp(context?: Partial<AppContext>): Promise<FastifyInstance> {
  const store = context?.store ?? new JsonStore();
  await store.init();

  const policy = new PolicyEngine(async (runId) => {
    const [run, permissions] = await Promise.all([store.getRun(runId), store.getPermissions(runId)]);
    if (!run || !permissions) return undefined;
    return { permissions, expectedFiles: run.expectedFiles };
  });

  const events = context?.events ?? new EventCollector(store, policy);
  const runtime = context?.runtime ?? new RuntimeManager(store, events);
  const intents = context?.intents ?? new IntentService(store);
  const findings = context?.findings ?? new FindingService(store, events);
  const analysis = context?.analysis ?? new BehaviorAnalysisService(store, findings);
  const reviews = context?.reviews ?? new ReviewService(store, events, findings, analysis);
  const resolutions = context?.resolutions ?? new ResolutionService(store, events, runtime, findings, analysis, reviews);
  const summaries = context?.summaries ?? new SummaryService(store);

  events.subscribeAll((event) => {
    if (event.category !== "runtime" || event.action !== "completed") return;
    void store.getRun(event.runId).then(async (run) => {
      if (!run?.intentId || run.purpose === "planner") return;
      await analysis.analyzeRun(run.id).catch(async (error: unknown) => {
        await events.emitEvent({
          runId: run.id,
          taskId: run.taskId,
          agentId: run.agentId,
          category: "runtime",
          action: "analysis_failed",
          severity: "medium",
          metadata: { reason: error instanceof Error ? error.message : String(error) }
        });
      });
    });
  });

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/agent-profiles", async () => ({ profiles: await runtime.getAgentProfiles() }));

  app.post("/api/runs", async (request, reply) => {
    try {
      const body = { ...(request.body as CreateRunRequest) };
      if (body.intent && body.intentId) throw new Error("Provide either intent or intentId, not both");
      if (body.intent) {
        const intent = await intents.create(body.taskId, body.intent, {
          agentId: body.agentId,
          agentType: body.agent?.kind ?? "generic"
        });
        body.intentId = intent.id;
        body.expectedFiles ??= intent.expectedFiles;
      } else if (body.intentId) {
        const intent = await store.getIntent(body.intentId);
        if (!intent) throw new Error(`Intent not found: ${body.intentId}`);
        body.expectedFiles ??= intent.expectedFiles;
      }
      const run = await runtime.createRun(body);
      if (body.intentId) await intents.attachToRun(body.intentId, run.id, run.taskId);
      return reply.code(202).send({
        runId: run.id,
        sandboxId: run.sandboxId ?? null,
        containerId: run.containerId ?? null,
        runtimeProvider: run.runtimeProvider,
        status: run.status
      });
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/runs", async () => ({ runs: await store.listRuns() }));

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return run;
  });

  app.post("/api/runs/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await runtime.stopRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return run;
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return { events: await events.getEvents(id) };
  });

  app.get("/api/runs/:id/permissions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const permissions = await store.getPermissions(id);
    if (!permissions) return reply.code(404).send({ error: "Run not found" });
    return permissions;
  });

  app.get("/api/runs/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return {
      runId: id,
      gitSummary: run.gitSummary ?? null,
      files: run.gitSummary?.files ?? [],
      diff: run.gitSummary?.diff ?? null
    };
  });

  app.post("/api/intents", async (request, reply) => {
    try {
      const body = request.body as AgentIntentDraft & { taskId: string; agentId?: string; agentType?: string };
      const intent = await intents.create(body.taskId, body, {
        agentId: body.createdBy?.agentId ?? body.agentId ?? "human",
        agentType: body.createdBy?.agentType ?? body.agentType ?? "human"
      });
      return reply.code(201).send(intent);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intents/generate", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    try {
      const taskId = requiredBodyString(body.taskId, "taskId");
      const agentId = requiredBodyString(body.agentId, "agentId");
      let draft: AgentIntentDraft;
      if (body.structuredOutput !== undefined) {
        draft = intents.parseGeneratedOutput(body.structuredOutput);
      } else {
        const plannerRequest = plannerRunRequest(body, taskId, agentId);
        const plannerRun = await runtime.createRun(plannerRequest);
        const completed = await runtime.waitForTerminal(plannerRun.id, plannerRequest.timeoutMs);
        const plannerEvents = await store.getEvents(completed.id);
        const generated = extractGeneratedIntent(plannerEvents);
        if (!generated) {
          await events.emitEvent({
            runId: completed.id,
            taskId,
            agentId,
            category: "runtime",
            action: "intent_generation_failed",
            severity: "medium",
            metadata: { reason: "Planner produced no valid structured intent" }
          });
          throw new Error("Planner produced no valid structured intent");
        }
        draft = intents.parseGeneratedOutput(generated);
      }
      const intent = await intents.create(taskId, draft, {
        agentId,
        agentType: typeof body.agentType === "string" ? body.agentType : "planner"
      });
      return reply.code(201).send(intent);
    } catch (error: unknown) {
      return reply.code(422).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/intents/:id", async (request, reply) => {
    const intent = await store.getIntent((request.params as { id: string }).id);
    return intent ?? reply.code(404).send({ error: "Intent not found" });
  });

  app.get("/api/runs/:id/intent", async (request, reply) => {
    const run = await store.getRun((request.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const intent = run.intentId ? await store.getIntent(run.intentId) : await store.getIntentForRun(run.id);
    return intent ?? reply.code(404).send({ error: "Intent not found" });
  });

  app.get("/api/findings", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      findings: await findings.list({
        status: query.status as FindingStatus | undefined,
        severity: query.severity as EventSeverity | undefined,
        runId: query.runId,
        taskId: query.taskId,
        source: query.source as FindingSource | undefined
      })
    };
  });

  app.get("/api/findings/:id", async (request, reply) => {
    const finding = await findings.get((request.params as { id: string }).id);
    return finding ?? reply.code(404).send({ error: "Finding not found" });
  });

  app.post("/api/findings/:id/dismiss", async (request, reply) => {
    try {
      return await findings.dismiss((request.params as { id: string }).id, (request.body ?? {}) as { reason?: string; actor?: string });
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/findings/:id/resolve", async (request, reply) => {
    try {
      const attempt = await resolutions.resolve(
        (request.params as { id: string }).id,
        (request.body ?? {}) as ResolveFindingRequest
      );
      return reply.code(202).send(attempt);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/resolutions/:id", async (request, reply) => {
    const attempt = await store.getResolution((request.params as { id: string }).id);
    return attempt ?? reply.code(404).send({ error: "Resolution not found" });
  });

  app.post("/api/runs/:id/review", async (request, reply) => {
    try {
      const review = await reviews.create(
        (request.params as { id: string }).id,
        (request.body ?? {}) as { reviewerAgentId?: string; structuredOutput?: unknown }
      );
      return reply.code(201).send(review);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/reviews", async () => ({ reviews: await store.listReviews() }));

  app.get("/api/reviews/:id", async (request, reply) => {
    const review = await store.getReview((request.params as { id: string }).id);
    return review ?? reply.code(404).send({ error: "Review not found" });
  });

  app.get("/api/reviews/:id/findings", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const review = await store.getReview(id);
    if (!review) return reply.code(404).send({ error: "Review not found" });
    const findingIds = new Set(review.findingIds ?? review.fileReviews.flatMap((file) => file.findingIds));
    return { findings: (await store.listFindings()).filter((finding) => findingIds.has(finding.id)) };
  });

  app.post("/api/reviews/:id/approve", async (request, reply) => {
    try {
      return await reviews.approve(
        (request.params as { id: string }).id,
        (request.body ?? {}) as { actor?: string; reason?: string }
      );
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/dashboard/summary", async () => summaries.dashboard());

  app.get("/api/agents/:id/summary", async (request, reply) => {
    try {
      return await summaries.agent((request.params as { id: string }).id);
    } catch (error: unknown) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/runs/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    for (const event of await events.getEvents(id)) {
      reply.raw.write(`event: ${event.category}.${event.action}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = events.subscribe(id, (event) => {
      reply.raw.write(`event: ${event.category}.${event.action}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    request.raw.on("close", unsubscribe);
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredBodyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function plannerRunRequest(body: Record<string, unknown>, taskId: string, agentId: string): CreateRunRequest {
  const repo = body.repo as CreateRunRequest["repo"] | undefined;
  const agent = body.agent as CreateRunRequest["agent"] | undefined;
  const command = body.command as string[] | undefined;
  if (!repo?.path) throw new Error("repo.path is required for planner generation");
  if (!agent && !command?.length) throw new Error("agent or command is required for planner generation");
  const instruction = [
    "Analyze the task without modifying the repository.",
    "Emit exactly one AGENTGUARD_EVENT line with category agent, action intent, and metadata.intent.",
    "The intent object must include goal, summary, plannedChanges, expectedFiles, expectedDependencies, expectedNetwork, expectedMcpServers, expectedSecrets, and constraints.",
    typeof body.goal === "string" ? `Task: ${body.goal}` : ""
  ].filter(Boolean).join(" ");
  return {
    taskId,
    agentId,
    repo,
    command,
    agent: agent ? { ...agent, prompt: instruction } : undefined,
    permissions: (body.permissions as CreateRunRequest["permissions"]) ?? {
      filesystem: [{ path: "/workspace", access: "read" }]
    },
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 300_000,
    cleanupWorkspace: true,
    runtime: body.runtime as CreateRunRequest["runtime"],
    purpose: "planner"
  };
}

function extractGeneratedIntent(eventList: Awaited<ReturnType<JsonStore["getEvents"]>>): unknown {
  for (const event of [...eventList].reverse()) {
    if (event.category === "agent" && event.action === "intent" && event.metadata?.intent) return event.metadata.intent;
    if (event.category === "agent" && event.action === "message" && typeof event.metadata?.text === "string") {
      const marker = "AGENTGUARD_EVENT ";
      const index = event.metadata.text.indexOf(marker);
      if (index >= 0) {
        try {
          const parsed = JSON.parse(event.metadata.text.slice(index + marker.length).trim()) as { metadata?: { intent?: unknown } };
          if (parsed.metadata?.intent) return parsed.metadata.intent;
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}
