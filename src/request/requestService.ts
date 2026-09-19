import type { JsonStore } from "../store/jsonStore.js";
import type { HumanRequest, RequestAnalysis } from "../types.js";
import { createId } from "../utils/id.js";
import { RequestAnalyzer } from "./requestAnalyzer.js";
import { DEFAULT_REQUEST_RULES, compileRules, validateRules, type RequestAnalyzerRules } from "./requestRules.js";

export interface HumanRequestDraft {
  taskId: string;
  rawPrompt: string;
  explicitConstraints?: string[];
  requestedObjectives?: string[];
  analysisMode?: HumanRequest["analysisMode"];
  context?: HumanRequest["context"];
}

export class RequestService {
  private rules: RequestAnalyzerRules = DEFAULT_REQUEST_RULES;
  private rulesLoaded = false;
  private readonly analyzer: RequestAnalyzer;

  constructor(private readonly store: JsonStore, analyzer?: RequestAnalyzer) {
    this.analyzer = analyzer ?? new RequestAnalyzer(() => this.rules);
  }

  async create(draft: HumanRequestDraft): Promise<{ request: HumanRequest; analysis: RequestAnalysis }> {
    await this.loadRules();
    const validated = validateRequestDraft(draft);
    const request: HumanRequest = Object.freeze({
      id: createId("req"),
      taskId: validated.taskId,
      rawPrompt: validated.rawPrompt,
      explicitConstraints: validated.explicitConstraints,
      requestedObjectives: validated.requestedObjectives,
      analysisMode: validated.analysisMode,
      context: validated.context,
      createdAt: new Date().toISOString()
    });
    const analysis = this.analyzer.analyze(request);
    await this.store.createRequest({ ...request });
    await this.store.createRequestAnalysis(analysis);
    return { request, analysis };
  }

  /** Runs the analyzer without persisting anything, optionally against unsaved rules — used by the rule editor and the request form. */
  async preview(rawPrompt: string, rules?: unknown): Promise<RequestAnalysis> {
    await this.loadRules();
    if (!rawPrompt.trim()) throw new Error("rawPrompt must be a non-empty string");
    const effective: RequestAnalyzerRules = rules === undefined
      ? this.rules
      : { ...validateRules(rules), revision: this.rules.revision, updatedAt: this.rules.updatedAt };
    const request: HumanRequest = { id: "req_preview", taskId: "preview", rawPrompt, createdAt: new Date().toISOString() };
    return this.analyzer.analyzeWith(request, compileRules(effective));
  }

  async getRules(): Promise<RequestAnalyzerRules> {
    await this.loadRules();
    return this.rules;
  }

  async updateRules(value: unknown): Promise<RequestAnalyzerRules> {
    await this.loadRules();
    const next: RequestAnalyzerRules = { ...validateRules(value), revision: this.rules.revision + 1, updatedAt: new Date().toISOString() };
    await this.store.setRequestRules(next);
    this.rules = next;
    return next;
  }

  async resetRules(): Promise<RequestAnalyzerRules> {
    await this.loadRules();
    const next: RequestAnalyzerRules = { ...DEFAULT_REQUEST_RULES, revision: this.rules.revision + 1, updatedAt: new Date().toISOString() };
    await this.store.setRequestRules(next);
    this.rules = next;
    return next;
  }

  private async loadRules(): Promise<void> {
    if (this.rulesLoaded) return;
    const stored = await this.store.getRequestRules();
    if (stored) this.rules = stored;
    this.rulesLoaded = true;
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
    analysisMode: validateAnalysisMode(record.analysisMode),
    context: validateContext(record.context)
  };
}

function validateAnalysisMode(value: unknown): HumanRequest["analysisMode"] {
  if (value === undefined) return undefined;
  if (value !== "rules" && value !== "manual") throw new Error("request.analysisMode must be 'rules' or 'manual'");
  return value;
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
