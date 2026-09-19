import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type { EventCollector } from "../events/eventCollector.js";
import type { RunRecord } from "../types.js";

export class FilesystemMonitor {
  private watcher?: FSWatcher;
  private readonly seen = new Set<string>();
  private baseline = new Map<string, string>();

  constructor(
    private readonly workspacePath: string,
    private readonly run: RunRecord,
    private readonly events: EventCollector
  ) {}

  async start(): Promise<void> {
    this.baseline = await snapshotFiles(this.workspacePath);
    this.watcher = chokidar.watch(this.workspacePath, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\.git([/\\]|$)/,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    });

    this.watcher
      .on("add", (filePath) => void this.emit("create", filePath))
      .on("change", (filePath) => void this.emit("write", filePath))
      .on("unlink", (filePath) => void this.emit("delete", filePath));

    await new Promise<void>((resolve) => this.watcher?.on("ready", () => resolve()));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  async reconcile(): Promise<void> {
    const current = await snapshotFiles(this.workspacePath);

    for (const [relativePath, fingerprint] of current) {
      const previous = this.baseline.get(relativePath);
      if (previous === undefined) await this.emit("create", path.join(this.workspacePath, relativePath));
      else if (previous !== fingerprint) await this.emit("write", path.join(this.workspacePath, relativePath));
    }

    for (const relativePath of this.baseline.keys()) {
      if (!current.has(relativePath)) await this.emit("delete", path.join(this.workspacePath, relativePath));
    }
  }

  private async emit(action: "create" | "write" | "delete", filePath: string): Promise<void> {
    const resource = `/workspace/${path.relative(this.workspacePath, filePath).replaceAll(path.sep, "/")}`;
    const dedupeKey = `${action}:${resource}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);

    await this.events.emitEvent({
      runId: this.run.id,
      taskId: this.run.taskId,
      agentId: this.run.agentId,
      category: "filesystem",
      action,
      resource,
      allowed: true
    });
  }
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        snapshot.set(path.relative(root, fullPath), `${info.size}:${info.mtimeMs}`);
      }
    }
  }

  await visit(root);
  return snapshot;
}
