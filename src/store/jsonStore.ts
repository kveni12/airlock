import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, GitSummary, PermissionSnapshot, RunRecord, StoredData } from "../types.js";

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

  async setGitSummary(runId: string, gitSummary: GitSummary): Promise<void> {
    await this.update((data) => {
      const run = data.runs.find((item) => item.id === runId);
      if (run) run.gitSummary = gitSummary;
    });
  }

  private async read(): Promise<StoredData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoredData;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { runs: [], events: [], permissions: {} };
      }
      throw error;
    }
  }

  private async update(mutator: (data: StoredData) => void): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const data = await this.read();
      mutator(data);
      await this.write(data);
    });
    await this.writeChain;
  }

  private async write(data: StoredData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}
