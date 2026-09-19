import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateRunRequest, GitSummary, PermissionSnapshot, RunRecord, RunStatus } from "../types.js";
import { AGENT_PROFILES, resolveAgent } from "../agents/agentAdapter.js";
import { EventCollector } from "../events/eventCollector.js";
import { JsonStore } from "../store/jsonStore.js";
import { FilesystemMonitor } from "../telemetry/filesystemMonitor.js";
import { NetworkProxy } from "../telemetry/networkProxy.js";
import { AgentOutputMonitor } from "../telemetry/agentOutputMonitor.js";
import {
  checkoutBranch,
  collectGitSummary,
  ensureGitBaseline,
  getGitState,
  snapshotDependencies,
  type DependencySnapshot
} from "../telemetry/gitTelemetry.js";
import { createId } from "../utils/id.js";
import { DockerProvider } from "./dockerProvider.js";
import { LimaProvider } from "./limaProvider.js";
import type { SandboxHandle, SandboxProvider } from "./sandboxProvider.js";

export interface RuntimeManagerOptions {
  defaultProvider?: "lima" | "docker";
  image?: string;
  baseVm?: string;
  workspaceRoot?: string;
  memoryBytes?: number;
  cpuShares?: number;
  pidsLimit?: number;
}

export class RuntimeManager {
  private readonly providers: Record<"lima" | "docker", SandboxProvider>;
  private readonly active = new Map<string, { provider?: SandboxProvider; handle?: SandboxHandle; stopping: boolean }>();

  constructor(
    private readonly store: JsonStore,
    private readonly events: EventCollector,
    private readonly options: RuntimeManagerOptions = {}
  ) {
    this.providers = {
      lima: new LimaProvider({ baseVm: options.baseVm, pidsLimit: options.pidsLimit }),
      docker: new DockerProvider(options)
    };
  }

  async createRun(request: CreateRunRequest): Promise<RunRecord> {
    validateCreateRun(request);
    await assertReadableDirectory(request.repo.path);
    const agent = resolveAgent(request);
    const runtimeProvider = request.runtime?.provider ?? this.options.defaultProvider ?? defaultProvider();
    const permissions = request.permissions ?? {};
    const secretEnvironment = resolveSecretEnvironment(permissions);
    const runtimeEnvironment = { ...agent.environment, ...secretEnvironment };

    const now = new Date().toISOString();
    const run: RunRecord = {
      id: createId("run"),
      taskId: request.taskId,
      agentId: request.agentId,
      agent: agent.profile,
      status: "starting",
      createdAt: now,
      repoPath: request.repo.path,
      repoBranch: request.repo.branch,
      command: agent.command,
      runtimeProvider,
      runtimeImage: runtimeProvider === "docker" ? request.runtime?.image ?? this.image : undefined,
      runtimeBaseVm:
        runtimeProvider === "lima"
          ? request.runtime?.baseVm ?? this.options.baseVm ?? agent.defaultBaseVm
          : undefined,
      environmentKeys: Object.keys(runtimeEnvironment),
      timeoutMs: request.timeoutMs ?? 30 * 60 * 1000,
      expectedFiles: request.expectedFiles ?? [],
      cleanupWorkspace: request.cleanupWorkspace ?? !(request.intentId || request.intent || request.purpose === "resolver"),
      intentId: request.intentId,
      requestId: request.requestId,
      purpose: request.purpose ?? "builder",
      parentRunId: request.parentRunId
    };

    await this.store.createRun(run, permissions);
    this.events.registerSecrets(run.id, secretEnvironment);
    this.active.set(run.id, { stopping: false });
    void this.executeRun(run, permissions, runtimeEnvironment).catch((error: unknown) => {
      void this.failRun(run, error);
    });

    return run;
  }

  async getAgentProfiles(): Promise<Array<(typeof AGENT_PROFILES)[number] & { runtimeReady: boolean }>> {
    const lima = this.providers.lima as LimaProvider;
    return Promise.all(
      AGENT_PROFILES.map(async (profile) => ({
        ...profile,
        runtimeReady: await lima.isBaseAvailable(profile.defaultBaseVm)
      }))
    );
  }

  async stopRun(runId: string): Promise<RunRecord | undefined> {
    const active = this.active.get(runId);
    if (!active) return this.store.getRun(runId);

    active.stopping = true;
    await this.updateStatus(runId, "stopping");
    if (active.provider && active.handle) {
      await active.provider.stop(active.handle).catch(() => undefined);
    }
    return this.store.getRun(runId);
  }

  async waitForTerminal(runId: string, timeoutMs = 30 * 60 * 1000): Promise<RunRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.store.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (["completed", "failed", "stopped"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for run ${runId}`);
  }

  private async executeRun(
    run: RunRecord,
    permissions: PermissionSnapshot,
    agentEnvironment: Record<string, string>
  ): Promise<void> {
    let workspacePath: string | undefined;
    let fsMonitor: FilesystemMonitor | undefined;
    let networkProxy: NetworkProxy | undefined;
    let beforeGit: GitSummary["before"];
    let beforeDependencies: DependencySnapshot = {};
    let provider: SandboxProvider | undefined;
    let handle: SandboxHandle | undefined;
    let outputMonitor: AgentOutputMonitor | undefined;

    try {
      workspacePath = await this.createWorkspace(run);
      run.workspacePath = workspacePath;
      await this.store.updateRun(run.id, { workspacePath });
      await ensureGitBaseline(workspacePath);
      await checkoutBranch(workspacePath, run.repoBranch);

      beforeGit = await getGitState(workspacePath);
      beforeDependencies = await snapshotDependencies(workspacePath);

      fsMonitor = new FilesystemMonitor(workspacePath, run, this.events);
      await fsMonitor.start();

      networkProxy = new NetworkProxy(run, permissions.network ?? [], this.events);
      const proxyPort = await networkProxy.start();

      for (const secretName of permissions.secrets ?? []) {
        if (!(secretName in agentEnvironment)) continue;
        await this.events.emitEvent({
          runId: run.id,
          taskId: run.taskId,
          agentId: run.agentId,
          category: "secret",
          action: "available",
          resource: secretName,
          allowed: true
        });
      }

      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "runtime",
        action: "started",
        severity: "info",
        metadata: {
          provider: run.runtimeProvider,
          runtime: run.runtimeProvider === "lima" ? run.runtimeBaseVm : run.runtimeImage,
          workspace: "/workspace",
          proxyPort,
          agentKind: run.agent?.kind ?? "generic",
          outputTelemetry: "jsonl_with_raw_fallback"
        }
      });

      provider = this.providers[run.runtimeProvider];
      outputMonitor = new AgentOutputMonitor(run, this.events);
      const proxyHostname = provider.proxyHostname;
      handle = await provider.create({
        run,
        workspacePath,
        proxyUrl: networkProxy.getProxyUrl(proxyHostname),
        environment: agentEnvironment,
        onOutput: (output) => outputMonitor?.observe(output)
      });
      this.active.set(run.id, { ...(this.active.get(run.id) ?? { stopping: false }), provider, handle });

      if (this.active.get(run.id)?.stopping) {
        await this.store.updateRun(run.id, {
          sandboxId: handle.id,
          sandboxName: handle.name,
          containerId: run.runtimeProvider === "docker" ? handle.id : null,
          status: "stopped",
          completedAt: new Date().toISOString(),
          exitCode: null
        });
        await this.events.emitEvent({
          runId: run.id,
          taskId: run.taskId,
          agentId: run.agentId,
          category: "runtime",
          action: "stopped",
          severity: "info",
          metadata: { reason: "Stopped before agent execution" }
        });
        return;
      }

      await this.store.updateRun(run.id, {
        sandboxId: handle.id,
        sandboxName: handle.name,
        containerId: run.runtimeProvider === "docker" ? handle.id : null,
        containerName: run.runtimeProvider === "docker" ? handle.name : undefined,
        status: "running",
        startedAt: new Date().toISOString()
      });

      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "process",
        action: "start",
        resource: run.command[0],
        allowed: true,
        metadata: { args: run.command.slice(1), command: run.command }
      });

      await provider.start(handle);
      const result = await this.waitWithTimeout(provider, handle, run);
      await outputMonitor.flush();
      const exitCode = result.exitCode;

      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "process",
        action: "exit",
        resource: run.command[0],
        allowed: true,
        metadata: { exitCode }
      });

      await fsMonitor.reconcile();
      const gitSummary = await this.finishTelemetry(run, workspacePath, beforeGit, beforeDependencies);
      const active = this.active.get(run.id);
      const finalStatus: RunStatus = active?.stopping ? "stopped" : exitCode === 0 ? "completed" : "failed";
      await this.store.setGitSummary(run.id, gitSummary);
      await this.store.updateRun(run.id, {
        status: finalStatus,
        completedAt: new Date().toISOString(),
        exitCode,
        failureReason: exitCode === 0 || finalStatus === "stopped" ? undefined : `Agent command exited with code ${exitCode}`
      });

      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "runtime",
        action: finalStatus === "completed" ? "completed" : finalStatus,
        severity: finalStatus === "completed" ? "info" : "medium",
        metadata: { exitCode }
      });
    } catch (error: unknown) {
      await this.failRun(run, error);
    } finally {
      await outputMonitor?.flush().catch(() => undefined);
      await fsMonitor?.stop().catch(() => undefined);
      await networkProxy?.stop().catch(() => undefined);
      await this.cleanup(run.id, workspacePath, run.cleanupWorkspace, provider, handle);
      this.events.clearSecrets(run.id);
    }
  }

  private async waitWithTimeout(
    provider: SandboxProvider,
    handle: SandboxHandle,
    run: RunRecord
  ): Promise<{ exitCode: number | null }> {
    const timeoutMs = run.timeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Agent run timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([provider.wait(handle), timeoutPromise]);
    } catch (error) {
      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "runtime",
        action: "failed",
        severity: "high",
        metadata: { reason: (error as Error).message }
      });
      await provider.stop(handle).catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async finishTelemetry(
    run: RunRecord,
    workspacePath: string,
    beforeGit: GitSummary["before"],
    beforeDependencies: DependencySnapshot
  ): Promise<GitSummary> {
    const gitSummary = await collectGitSummary(workspacePath, beforeGit, beforeDependencies);

    for (const file of gitSummary.files) {
      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "git",
        action: "file_changed",
        resource: file,
        allowed: true
      });
    }

    for (const commit of gitSummary.commits) {
      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "git",
        action: "commit",
        resource: commit,
        allowed: true
      });
    }

    for (const change of gitSummary.dependencyChanges) {
      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "git",
        action: change.type,
        resource: change.name,
        allowed: true,
        metadata: { ...change }
      });
    }

    await this.events.emitEvent({
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      category: "git",
      action: "diff_generated",
      severity: "info",
      metadata: {
        filesChanged: gitSummary.filesChanged,
        insertions: gitSummary.insertions,
        deletions: gitSummary.deletions
      }
    });

    return gitSummary;
  }

  private async failRun(run: RunRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason: message
    });
    await this.events.emitEvent({
      runId: run.id,
      taskId: run.taskId,
      agentId: run.agentId,
      category: "runtime",
      action: "failed",
      severity: "high",
      metadata: { reason: message }
    });
  }

  private async updateStatus(runId: string, status: RunStatus): Promise<void> {
    await this.store.updateRun(runId, { status });
  }

  private async createWorkspace(run: RunRecord): Promise<string> {
    const workspaceRoot = this.options.workspaceRoot ?? os.tmpdir();
    const workspacePath = await mkdtemp(path.join(workspaceRoot, `agentguard-${run.id}-`));
    await cp(run.repoPath, workspacePath, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`)
    });
    return workspacePath;
  }

  private async cleanup(
    runId: string,
    workspacePath: string | undefined,
    cleanupWorkspace: boolean,
    provider?: SandboxProvider,
    handle?: SandboxHandle
  ): Promise<void> {
    const active = this.active.get(runId);
    const cleanupProvider = provider ?? active?.provider;
    const cleanupHandle = handle ?? active?.handle;
    if (cleanupProvider && cleanupHandle) {
      await cleanupProvider.stop(cleanupHandle).catch(() => undefined);
      await cleanupProvider.remove(cleanupHandle).catch(() => undefined);
    }
    if (workspacePath && cleanupWorkspace) {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
    this.active.delete(runId);
  }

  private get image(): string {
    return this.options.image ?? "agentguard-runtime:latest";
  }
}

async function assertReadableDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Repository path is not a directory: ${directory}`);
}

function validateCreateRun(request: CreateRunRequest): void {
  if (!request.taskId) throw new Error("taskId is required");
  if (!request.agentId) throw new Error("agentId is required");
  if (!request.repo?.path) throw new Error("repo.path is required");
  if (!request.command?.length && !request.agent?.command?.length && !request.agent) {
    throw new Error("command or agent profile is required");
  }
}

function defaultProvider(): "lima" | "docker" {
  return process.env.AGENTGUARD_RUNTIME_PROVIDER === "docker" ? "docker" : "lima";
}

function resolveSecretEnvironment(permissions: PermissionSnapshot): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const name of permissions.secrets ?? []) {
    const value = process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  return secrets;
}
