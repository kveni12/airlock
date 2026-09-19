import type { JsonStore } from "../store/jsonStore.js";
import type { HumanRequest, RequestAnalysis } from "../types.js";
import { createId } from "../utils/id.js";
import { RequestAnalyzer } from "./requestAnalyzer.js";

export interface HumanRequestDraft {
  taskId: string;
  rawPrompt: string;
  explicitConstraints?: string[];
  requestedObjectives?: string[];
  context?: HumanRequest["context"];
}

export class RequestService {
  constructor(
    private readonly store: JsonStore,
    private readonly analyzer = new RequestAnalyzer()
  ) {}

  async create(draft: HumanRequestDraft): Promise<{ request: HumanRequest; analysis: RequestAnalysis }> {
    const validated = validateRequestDraft(draft);
    const request: HumanRequest = Object.freeze({
      id: createId("req"),
      taskId: validated.taskId,
      rawPrompt: validated.rawPrompt,
      explicitConstraints: validated.explicitConstraints,
      requestedObjectives: validated.requestedObjectives,
      context: validated.context,
      createdAt: new Date().toISOString()
    });
    const analysis = this.analyzer.analyze(request);
    await this.store.createRequest({ ...request });
    await this.store.createRequestAnalysis(analysis);
    return { request, analysis };
  }

  async get(requestId: string): Promise<HumanRequest | undefined> {
    return this.store.getRequest(requestId);
  }

  async getAnalysis(requestId: string): Promise<RequestAnalysis | undefined> {
    return this.store.getRequestAnalysis(requestId);
  }

  async attachToRun(requestId: string, runId: string): Promise<HumanRequest> {
    const request = await this.store.getRequest(requestId);
    if (!request) throw new Error(`Request '${requestId}' was not found`);
    if (request.runId && request.runId !== runId) {
      throw new Error(`Request '${requestId}' is already attached to run '${request.runId}'`);
    }
    return (await this.store.attachRequestToRun(requestId, runId)) ?? request;
  }
}

export function validateRequestDraft(value: unknown): HumanRequestDraft {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  const record = value as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  if (!taskId) throw new Error("request.taskId is required");
  const rawPrompt = typeof record.rawPrompt === "string" ? record.rawPrompt : "";
  if (!rawPrompt.trim()) throw new Error("request.rawPrompt must be a non-empty string");
  if (rawPrompt.length > 20_000) throw new Error("request.rawPrompt exceeds 20000 characters");
  return {
    taskId,
    rawPrompt,
    explicitConstraints: optionalStringArray(record.explicitConstraints, "request.explicitConstraints"),
    requestedObjectives: optionalStringArray(record.requestedObjectives, "request.requestedObjectives"),
    context: validateContext(record.context)
  };
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

function validateContext(value: unknown): HumanRequest["context"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("request.context must be an object");
  const record = value as Record<string, unknown>;
  const attachments = optionalStringArray(record.attachments, "request.context.attachments");
  const metadata = record.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new Error("request.context.metadata must be an object");
  }
  return { attachments, metadata: metadata as Record<string, unknown> | undefined };
}
