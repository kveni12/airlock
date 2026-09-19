import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { CreateRunRequest } from "./types.js";
import { JsonStore } from "./store/jsonStore.js";
import { PolicyEngine } from "./policy/policyEngine.js";
import { EventCollector } from "./events/eventCollector.js";
import { RuntimeManager } from "./runtime/runtimeManager.js";

export interface AppContext {
  store: JsonStore;
  events: EventCollector;
  runtime: RuntimeManager;
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

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/agent-profiles", async () => ({ profiles: await runtime.getAgentProfiles() }));

  app.post("/api/runs", async (request, reply) => {
    try {
      const run = await runtime.createRun(request.body as CreateRunRequest);
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
