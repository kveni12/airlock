import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AgentIntent, AgentIntentDraft, CreateRunRequest, FindingSource, FindingStatus, EventSeverity, PermissionSnapshot, RunRecord } from "./types.js";
import { JsonStore } from "./store/jsonStore.js";
import { AuthService } from "./auth/authService.js";
import { openSignupEnabled, registerAuth } from "./auth/authRoutes.js";
import { resolveGoogleConfig } from "./auth/googleOAuth.js";
import { PolicyEngine } from "./policy/policyEngine.js";
import { EventCollector } from "./events/eventCollector.js";
import { RuntimeManager } from "./runtime/runtimeManager.js";
import { IntentService } from "./intent/intentService.js";
import { IntentAmendmentService } from "./intent/intentAmendmentService.js";
import { PLANNER_OUTPUT_INSTRUCTION, extractGeneratedIntent } from "./intent/generatedIntentExtractor.js";
import { IntentAlignmentService } from "./intent/intentAlignmentService.js";
import { ProjectService } from "./projects/projectService.js";
import { RequestService, validateRequestDraft } from "./request/requestService.js";
import { FindingService } from "./findings/findingService.js";
import { BehaviorAnalysisService } from "./analysis/behaviorAnalyzer.js";
import { ReviewService } from "./review/reviewService.js";
import { ResolutionService, type ResolveFindingRequest } from "./resolution/resolutionService.js";
import { SummaryService } from "./dashboard/summaryService.js";
import { RunInsightService } from "./dashboard/runInsightService.js";
import { analyzeAccessGaps } from "./analysis/accessGapAnalyzer.js";
import { listRepoDirectory } from "./repo/repoTree.js";

export interface AppContext {
  store: JsonStore;
  auth: AuthService;
  events: EventCollector;
  runtime: RuntimeManager;
  requests: RequestService;
  intents: IntentService;
  amendments: IntentAmendmentService;
  intentAlignment: IntentAlignmentService;
  findings: FindingService;
  analysis: BehaviorAnalysisService;
  reviews: ReviewService;
  resolutions: ResolutionService;
  summaries: SummaryService;
  insights: RunInsightService;
}

export async function createApp(context?: Partial<AppContext>): Promise<FastifyInstance> {
  const store = context?.store ?? new JsonStore();
  await store.init();
  const auth = context?.auth ?? new AuthService(store);

  const policy = new PolicyEngine(async (runId) => {
    const [run, permissions] = await Promise.all([store.getRun(runId), store.getPermissions(runId)]);
    if (!run || !permissions) return undefined;
    return { permissions, expectedFiles: run.expectedFiles };
  });

  const events = context?.events ?? new EventCollector(store, policy);
  const runtime = context?.runtime ?? new RuntimeManager(store, events);
  const recovered = context?.runtime ? undefined : await runtime.recover();
  const requests = context?.requests ?? new RequestService(store);
  const projects = new ProjectService(store);
  const intents = context?.intents ?? new IntentService(store);
  const amendments = context?.amendments ?? new IntentAmendmentService(store, events, intents);
  runtime.attachAmendments(amendments);
  const findings = context?.findings ?? new FindingService(store, events);
  const intentAlignment = context?.intentAlignment ?? new IntentAlignmentService(store, intents, findings);
  const analysis = context?.analysis ?? new BehaviorAnalysisService(store, findings);
  const reviews = context?.reviews ?? new ReviewService(store, events, findings, analysis);
  const resolutions = context?.resolutions ?? new ResolutionService(store, events, runtime, findings, analysis, reviews);
  const summaries = context?.summaries ?? new SummaryService(store);
  const insights = context?.insights ?? new RunInsightService(store);

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

  const alignIfRequested = async (intent: Awaited<ReturnType<IntentService["create"]>>) =>
    intent.requestId ? (await intentAlignment.analyze(intent.id)).intent : intent;

  const app = Fastify({ logger: true });
  if (recovered && (recovered.failedRuns.length || Object.values(recovered.reaped).some((ids) => ids.length))) {
    app.log.warn({ recovered }, "Recovered sandboxes left behind by a previous backend process");
  }
  const allowedOrigins = resolveAllowedOrigins();
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  const google = resolveGoogleConfig();
  await registerAuth(app, auth, { allowedOrigins, cookieSecure: process.env.PERISCOPE_COOKIE_SECURE === "1", google, openSignup: openSignupEnabled() });
  if (google) {
    app.log.info({ redirectUri: google.redirectUri }, "Google sign-in enabled");
  }

  const setupToken = await auth.issueSetupToken();
  if (setupToken) {
    app.log.warn(`Periscope has no operator account yet. Create the first administrator at /setup with this one-time token: ${setupToken}`);
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/agent-profiles", async () => ({ profiles: await runtime.getAgentProfiles() }));

  app.get("/api/runtime/status", async () => runtime.setup.status());

  app.post("/api/runtime/setup", async (request, reply) => {
    const body = request.body as { provider?: string; agent?: string } | undefined;
    if (body?.provider === "docker") return reply.code(202).send(runtime.setup.startSetup({ provider: "docker" }));
    if (body?.provider === "lima") return reply.code(202).send(runtime.setup.startSetup({ provider: "lima", agent: body.agent }));
    return reply.code(400).send({ error: "provider must be 'docker' or 'lima'" });
  });

  app.get("/api/runtime/setup", async () => ({ jobs: runtime.setup.listJobs() }));

  app.get("/api/runtime/setup/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = runtime.setup.getJob(id);
    return job ?? reply.code(404).send({ error: `Setup job ${id} not found` });
  });

  app.post("/api/runs", async (request, reply) => {
    try {
      const body = { ...(request.body as CreateRunRequest) };
      if (body.intent && body.intentId) throw new Error("Provide either intent or intentId, not both");
      if (body.requestId) {
        const humanRequest = await requests.get(body.requestId);
        if (!humanRequest) throw new Error(`Request not found: ${body.requestId}`);
        if (humanRequest.runId) throw new Error(`Request ${body.requestId} is already attached to run ${humanRequest.runId}`);
      }
      if (body.intent) {
        const intent = await intents.create(body.taskId, body.intent, {
          agentId: body.agentId,
          agentType: body.agent?.kind ?? "generic",
          requestId: body.requestId
        });
        if (body.requestId) await intentAlignment.analyze(intent.id);
        body.intentId = intent.id;
        body.expectedFiles ??= intent.expectedFiles;
      }
      if (body.intentId) {
        const intent = await intents.get(body.intentId);
        if (!intent) throw new Error(`Intent not found: ${body.intentId}`);
        if (intent.requestId && body.requestId && intent.requestId !== body.requestId) {
          throw new Error(`Intent ${intent.id} belongs to request ${intent.requestId}, not ${body.requestId}`);
        }
        body.requestId ??= intent.requestId;
        const blocked = intents.executionBlockReason(intent);
        if (blocked) throw new Error(blocked);
        body.expectedFiles ??= intent.expectedFiles;
      }
      const run = await runtime.createRun(body);
      if (body.requestId) await requests.attachToRun(body.requestId, run.id);
      if (body.intentId) {
        await intents.attachToRun(body.intentId, run.id, run.taskId);
        await intentAlignment.attachFindingsToRun(body.intentId, run.id);
      }
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

  /** Planner runs recorded before intents back-filled their run record: derive links from the intent they produced. */
  const withPlannerLinks = (run: RunRecord, allIntents: AgentIntent[]): RunRecord => {
    if (run.intentId && run.requestId) return run;
    const produced = allIntents.find((intent) => intent.planningRunId === run.id);
    if (!produced) return run;
    return { ...run, intentId: run.intentId ?? produced.id, requestId: run.requestId ?? produced.requestId };
  };

  app.get("/api/runs", async () => {
    const [runs, allIntents] = await Promise.all([store.listRuns(), store.listIntents()]);
    return { runs: runs.map((run) => withPlannerLinks(run, allIntents)) };
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return withPlannerLinks(run, await store.listIntents());
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

  app.get("/api/repo-tree", async (request, reply) => {
    const { path: repoPath, dir } = request.query as { path?: string; dir?: string };
    if (!repoPath) return reply.code(400).send({ error: "path is required" });
    try {
      return await listRepoDirectory(repoPath, dir ?? "");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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

  app.post("/api/requests", async (request, reply) => {
    try {
      const created = await requests.create({ ...validateRequestDraft(request.body), createdBy: actorFor(request) });
      return reply.code(201).send(created);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/requests/preview", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { rawPrompt?: unknown; rules?: unknown };
      return await requests.preview(typeof body.rawPrompt === "string" ? body.rawPrompt : "", body.rules);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/projects", async () => projects.list());

  app.post("/api/projects", async (request, reply) => {
    try {
      return reply.code(201).send(await projects.create(request.body));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const project = await projects.get((request.params as { id: string }).id);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.put("/api/projects/:id", async (request, reply) => {
    try {
      const project = await projects.update((request.params as { id: string }).id, request.body);
      return project ?? reply.code(404).send({ error: "Project not found" });
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/projects/:id/open", async (request, reply) => {
    const project = await projects.open((request.params as { id: string }).id);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const removed = await projects.delete((request.params as { id: string }).id);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Project not found" });
  });

  app.get("/api/request-rules", async () => requests.getRules());

  app.put("/api/request-rules", async (request, reply) => {
    try {
      return await requests.updateRules(request.body);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/request-rules/reset", async () => requests.resetRules());

  app.get("/api/requests/:id", async (request, reply) => {
    const humanRequest = await requests.get((request.params as { id: string }).id);
    return humanRequest ?? reply.code(404).send({ error: "Request not found" });
  });

  app.get("/api/requests/:id/analysis", async (request, reply) => {
    const analysis = await requests.getAnalysis((request.params as { id: string }).id);
    return analysis ?? reply.code(404).send({ error: "Request analysis not found" });
  });

  for (const [route, load] of [
    ["detail", (id: string) => insights.detail(id)],
    ["alignment", (id: string) => insights.alignment(id)],
    ["timeline", async (id: string) => ({ runId: id, entries: await insights.timeline(id) })],
    ["result", (id: string) => insights.result(id)],
    ["behavior", async (id: string) => (await insights.detail(id)).behaviorSummary ?? { runId: id, unavailable: "Run has no attached intent; behavior summary requires one" }]
  ] as const) {
    app.get(`/api/runs/:id/${route}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await store.getRun(id))) return reply.code(404).send({ error: "Run not found" });
      return load(id);
    });
  }

  app.get("/api/runs/:id/request", async (request, reply) => {
    const run = await store.getRun((request.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const humanRequest = run.requestId ? await requests.get(run.requestId) : await store.getRequestForRun(run.id);
    return humanRequest ?? reply.code(404).send({ error: "Request not found" });
  });

  app.post("/api/intents", async (request, reply) => {
    try {
      const body = request.body as AgentIntentDraft & {
        taskId: string;
        agentId?: string;
        agentType?: string;
        requestId?: string;
        supersedes?: string;
      };
      const intent = await intents.create(body.taskId, body, {
        agentId: body.createdBy?.agentId ?? body.agentId ?? "human",
        agentType: body.createdBy?.agentType ?? body.agentType ?? "human",
        requestId: body.requestId,
        supersedes: body.supersedes
      });
      return reply.code(201).send(await alignIfRequested(intent));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intents/generate", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    try {
      const taskId = requiredBodyString(body.taskId, "taskId");
      const agentId = requiredBodyString(body.agentId, "agentId");
      const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      const humanRequest = requestId ? await requests.get(requestId) : undefined;
      if (requestId && !humanRequest) throw new Error(`Request not found: ${requestId}`);
      let draft: AgentIntentDraft;
      let planningRunId: string | undefined;
      if (body.structuredOutput !== undefined) {
        draft = intents.parseGeneratedOutput(body.structuredOutput);
      } else {
        const plannerRequest = plannerRunRequest(body, taskId, agentId, humanRequest?.rawPrompt, requestId);
        const plannerRun = await runtime.createRun(plannerRequest);
        planningRunId = plannerRun.id;
        const completed = await runtime.waitForTerminal(plannerRun.id, plannerRequest.timeoutMs);
        const plannerEvents = await store.getEvents(completed.id);
        const generated = extractGeneratedIntent(plannerEvents);
        if (completed.status !== "completed") {
          throw new Error(completed.failureReason ?? `Planner run ended with status ${completed.status}`);
        }
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
        try {
          draft = intents.parseGeneratedOutput(generated);
        } catch (error: unknown) {
          await events.emitEvent({
            runId: completed.id,
            taskId,
            agentId,
            category: "runtime",
            action: "intent_generation_failed",
            severity: "medium",
            metadata: { reason: `Planner produced malformed intent: ${errorMessage(error)}` }
          });
          throw error;
        }
      }
      const intent = await intents.create(taskId, draft, {
        agentId,
        agentType: typeof body.agentType === "string" ? body.agentType : "planner",
        requestId,
        planningRunId,
        supersedes: typeof body.supersedes === "string" ? body.supersedes : undefined
      });
      if (planningRunId) await store.updateRun(planningRunId, { intentId: intent.id, requestId });
      return reply.code(201).send(await alignIfRequested(intent));
    } catch (error: unknown) {
      return reply.code(422).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/intents/:id", async (request, reply) => {
    const intent = await intents.get((request.params as { id: string }).id);
    return intent ?? reply.code(404).send({ error: "Intent not found" });
  });

  app.get("/api/intents/:id/alignment", async (request, reply) => {
    const intent = await intents.get((request.params as { id: string }).id);
    if (!intent) return reply.code(404).send({ error: "Intent not found" });
    return {
      intentId: intent.id,
      requestId: intent.requestId ?? null,
      alignment: intent.alignment ?? null,
      approval: intent.approval ?? null,
      executionBlockReason: intents.executionBlockReason(intent) ?? null,
      findings: await intentAlignment.findingsFor(intent.id)
    };
  });

  app.post("/api/intents/:id/analyze", async (request, reply) => {
    try {
      return await intentAlignment.analyze((request.params as { id: string }).id);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intents/:id/access-check", async (request, reply) => {
    const intent = await intents.get((request.params as { id: string }).id);
    if (!intent) return reply.code(404).send({ error: "Intent not found" });
    const { permissions } = (request.body ?? {}) as { permissions?: PermissionSnapshot };
    return analyzeAccessGaps(intent, permissions ?? {});
  });

  app.post("/api/intents/:id/approve", async (request, reply) => {
    try {
      const body = decisionBody(request);
      return await intents.approve((request.params as { id: string }).id, body);
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/intent-amendments", async (request) => {
    const { runId } = request.query as { runId?: string };
    return { amendments: await amendments.list(runId) };
  });

  app.get("/api/intent-amendments/:id", async (request, reply) => {
    const amendment = await amendments.get((request.params as { id: string }).id);
    if (!amendment) return reply.code(404).send({ error: "Amendment not found" });
    return amendment;
  });

  app.get("/api/runs/:id/intent-amendments", async (request) => {
    return { amendments: await amendments.list((request.params as { id: string }).id) };
  });

  /** Agent-side request (also reachable from inside the sandbox via http://periscope.internal/amendments). */
  app.post("/api/runs/:id/intent-amendments", async (request, reply) => {
    try {
      return reply.code(201).send(await amendments.request((request.params as { id: string }).id, request.body, "control_channel"));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intent-amendments/:id/approve", async (request, reply) => {
    try {
      return await amendments.approve((request.params as { id: string }).id, decisionBody(request));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intent-amendments/:id/deny", async (request, reply) => {
    try {
      return await amendments.deny((request.params as { id: string }).id, decisionBody(request));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intents/:id/reject", async (request, reply) => {
    try {
      return await intents.reject((request.params as { id: string }).id, decisionBody(request));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/intents/:id/revise", async (request, reply) => {
    try {
      const previousId = (request.params as { id: string }).id;
      const previous = await intents.get(previousId);
      if (!previous) return reply.code(404).send({ error: "Intent not found" });
      const body = request.body as AgentIntentDraft & { agentId?: string; agentType?: string };
      const intent = await intents.create(previous.taskId, body, {
        agentId: body.createdBy?.agentId ?? body.agentId ?? previous.createdBy.agentId,
        agentType: body.createdBy?.agentType ?? body.agentType ?? previous.createdBy.agentType,
        requestId: previous.requestId,
        planningRunId: previous.planningRunId,
        supersedes: previous.id
      });
      return reply.code(201).send(await alignIfRequested(intent));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
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
      return await findings.dismiss((request.params as { id: string }).id, decisionBody(request));
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
      return await reviews.approve((request.params as { id: string }).id, decisionBody(request));
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/reviews/:id/reject", async (request, reply) => {
    try {
      return await reviews.reject((request.params as { id: string }).id, decisionBody(request));
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
      "X-Accel-Buffering": "no",
      ...corsHeadersFor(request.headers.origin, allowedOrigins)
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

/** The authenticated operator, so a recorded governance decision names a real account rather than a caller-supplied string. */
function actorFor(request: FastifyRequest): string | undefined {
  return request.user ? `${request.user.displayName} <${request.user.email}>` : undefined;
}

function decisionBody(request: FastifyRequest): { actor?: string; reason?: string } {
  const body = (request.body ?? {}) as { actor?: string; reason?: string };
  return { reason: body.reason, actor: actorFor(request) ?? body.actor };
}

function resolveAllowedOrigins(): string[] {
  const configured = process.env.PERISCOPE_ALLOWED_ORIGINS;
  if (!configured) return ["http://localhost:3001", "http://127.0.0.1:3001"];
  return configured.split(",").map((origin) => origin.trim()).filter(Boolean);
}

/** Hijacked responses (the SSE stream) bypass the CORS plugin and must set these themselves. */
export function corsHeadersFor(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin"
  };
}

function requiredBodyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function plannerRunRequest(body: Record<string, unknown>, taskId: string, agentId: string, rawPrompt?: string, requestId?: string): CreateRunRequest {
  const repo = body.repo as CreateRunRequest["repo"] | undefined;
  const agent = body.agent as CreateRunRequest["agent"] | undefined;
  const command = body.command as string[] | undefined;
  if (!repo?.path) throw new Error("repo.path is required for planner generation");
  if (!agent && !command?.length) throw new Error("agent or command is required for planner generation");
  const instruction = [
    PLANNER_OUTPUT_INSTRUCTION,
    rawPrompt ? `Human request: ${rawPrompt}` : typeof body.goal === "string" ? `Task: ${body.goal}` : ""
  ].filter(Boolean).join("\n\n");
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
    requestId,
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    purpose: "planner"
  };
}

