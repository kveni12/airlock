import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEvent,
  AgentIntent,
  Finding,
  GitSummary,
  HumanRequest,
  PermissionSnapshot,
  RequestAnalysis,
  ResolutionAttempt,
  Review,
  RunRecord,
  StoredData
} from "../types.js";

export class JsonStore {
  private writeChain = Promise.resolve();

  constructor(private readonly filePath = path.resolve("data", "agentguard-store.json")) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const data = await this.read();
    await this.write(data);
  }

  async createRun(run: RunRecord, permissions: PermissionSnapshot): Promise<void> {
    await this.update((data) => {
      data.runs.push(run);
      data.permissions[run.id] = permissions;
    });
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    let updated: RunRecord | undefined;
    await this.update((data) => {
      const run = data.runs.find((item) => item.id === runId);
      if (!run) return;
      Object.assign(run, patch);
      updated = run;
    });
    return updated;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const data = await this.read();
    return data.runs.find((run) => run.id === runId);
  }

  async listRuns(): Promise<RunRecord[]> {
    const data = await this.read();
    return data.runs;
  }

  async addEvent(event: AgentEvent): Promise<void> {
    await this.update((data) => {
      data.events.push(event);
    });
  }

  async getEvents(runId: string): Promise<AgentEvent[]> {
    const data = await this.read();
    return data.events.filter((event) => event.runId === runId);
  }

  async getPermissions(runId: string): Promise<PermissionSnapshot | undefined> {
    const data = await this.read();
    return data.permissions[runId];
  }

  async createRequest(request: HumanRequest): Promise<void> {
    await this.update((data) => data.requests.push(request));
  }

  async attachRequestToRun(requestId: string, runId: string): Promise<HumanRequest | undefined> {
    let updated: HumanRequest | undefined;
    await this.update((data) => {
      const request = data.requests.find((item) => item.id === requestId);
      if (!request) return;
      request.runId = runId;
      updated = request;
    });
    return updated;
  }

  async getRequest(requestId: string): Promise<HumanRequest | undefined> {
    return (await this.read()).requests.find((request) => request.id === requestId);
  }

  async getRequestForRun(runId: string): Promise<HumanRequest | undefined> {
    return (await this.read()).requests.find((request) => request.runId === runId);
  }

  async listRequests(): Promise<HumanRequest[]> {
    return (await this.read()).requests;
  }

  async createRequestAnalysis(analysis: RequestAnalysis): Promise<void> {
    await this.update((data) => data.requestAnalyses.push(analysis));
  }

  async getRequestAnalysis(requestId: string): Promise<RequestAnalysis | undefined> {
    return (await this.read()).requestAnalyses.find((analysis) => analysis.requestId === requestId);
  }

  async createIntent(intent: AgentIntent): Promise<void> {
    await this.update((data) => data.intents.push(intent));
  }

  async updateIntent(intentId: string, patch: Partial<AgentIntent>): Promise<AgentIntent | undefined> {
    let updated: AgentIntent | undefined;
    await this.update((data) => {
      const intent = data.intents.find((item) => item.id === intentId);
      if (!intent) return;
      Object.assign(intent, patch);
      updated = intent;
    });
    return updated;
  }

  async getIntent(intentId: string): Promise<AgentIntent | undefined> {
    return (await this.read()).intents.find((intent) => intent.id === intentId);
  }

  async getIntentForRun(runId: string): Promise<AgentIntent | undefined> {
    return (await this.read()).intents.find((intent) => intent.runId === runId);
  }

  async listIntents(): Promise<AgentIntent[]> {
    return (await this.read()).intents;
  }

  async createFinding(finding: Finding): Promise<void> {
    await this.update((data) => data.findings.push(finding));
  }

  async updateFinding(findingId: string, patch: Partial<Finding>): Promise<Finding | undefined> {
    let updated: Finding | undefined;
    await this.update((data) => {
      const finding = data.findings.find((item) => item.id === findingId);
      if (!finding) return;
      Object.assign(finding, patch);
      updated = finding;
    });
    return updated;
  }

  async getFinding(findingId: string): Promise<Finding | undefined> {
    return (await this.read()).findings.find((finding) => finding.id === findingId);
  }

  async listFindings(): Promise<Finding[]> {
    return (await this.read()).findings;
  }

  async createReview(review: Review): Promise<void> {
    await this.update((data) => data.reviews.push(review));
  }

  async updateReview(reviewId: string, patch: Partial<Review>): Promise<Review | undefined> {
    let updated: Review | undefined;
    await this.update((data) => {
      const review = data.reviews.find((item) => item.id === reviewId);
      if (!review) return;
      Object.assign(review, patch);
      updated = review;
    });
    return updated;
  }

  async getReview(reviewId: string): Promise<Review | undefined> {
    return (await this.read()).reviews.find((review) => review.id === reviewId);
  }

  async listReviews(): Promise<Review[]> {
    return (await this.read()).reviews;
  }

  async createResolution(attempt: ResolutionAttempt): Promise<void> {
    await this.update((data) => data.resolutions.push(attempt));
  }

  async updateResolution(id: string, patch: Partial<ResolutionAttempt>): Promise<ResolutionAttempt | undefined> {
    let updated: ResolutionAttempt | undefined;
    await this.update((data) => {
      const attempt = data.resolutions.find((item) => item.id === id);
      if (!attempt) return;
      Object.assign(attempt, patch);
      updated = attempt;
    });
    return updated;
  }

  async getResolution(id: string): Promise<ResolutionAttempt | undefined> {
    return (await this.read()).resolutions.find((attempt) => attempt.id === id);
  }

  async listResolutions(): Promise<ResolutionAttempt[]> {
    return (await this.read()).resolutions;
  }

  async setGitSummary(runId: string, gitSummary: GitSummary): Promise<void> {
    await this.update((data) => {
      const run = data.runs.find((item) => item.id === runId);
      if (run) run.gitSummary = gitSummary;
    });
  }

  private async read(): Promise<StoredData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeStoredData(JSON.parse(raw) as Partial<StoredData>);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStoredData();
      }
      throw error;
    }
  }

  private async update(mutator: (data: StoredData) => void): Promise<void> {
    const update = async (): Promise<void> => {
      const data = await this.read();
      mutator(data);
      await this.write(data);
    };

    // A transient filesystem error should fail its caller without permanently
    // poisoning the queue for all later writes.
    this.writeChain = this.writeChain.then(update, update);
    await this.writeChain;
  }

  private async write(data: StoredData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
      await renameWithRetry(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const maxRetries = 6;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_RENAME_ERRORS.has(code) || attempt >= maxRetries) {
        throw error;
      }

      await delay(25 * 2 ** attempt);
    }
  }
}

function emptyStoredData(): StoredData {
  return {
    runs: [],
    events: [],
    permissions: {},
    requests: [],
    requestAnalyses: [],
    intents: [],
    findings: [],
    reviews: [],
    resolutions: []
  };
}

function normalizeStoredData(data: Partial<StoredData>): StoredData {
  return {
    runs: data.runs ?? [],
    events: data.events ?? [],
    permissions: data.permissions ?? {},
    requests: data.requests ?? [],
    requestAnalyses: data.requestAnalyses ?? [],
    intents: (data.intents ?? []).map(normalizeStoredIntent),
    findings: data.findings ?? [],
    reviews: (data.reviews ?? []).map((review) => ({ ...review, findingIds: review.findingIds ?? [] })),
    resolutions: data.resolutions ?? []
  };
}

/** Fills fields added after Phase 2 so intents persisted by older stores stay usable. */
export function normalizeStoredIntent(intent: AgentIntent): AgentIntent {
  const plannedChanges = intent.plannedChanges ?? intent.plannedActions ?? [];
  return {
    ...intent,
    interpretation: intent.interpretation ?? intent.summary ?? intent.goal,
    plannedChanges,
    plannedActions: intent.plannedActions ?? plannedChanges,
    expectedCommands: intent.expectedCommands ?? [],
    expectedTools: intent.expectedTools ?? [],
    assumptions: intent.assumptions ?? []
  };
}
