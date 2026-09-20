import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateRunRequest, GitSummary, PermissionSnapshot, RunRecord, RunStatus, RuntimeProviderKind } from "../types.js";
import { AGENT_PROFILES, resolveAgent } from "../agents/agentAdapter.js";
import { EventCollector } from "../events/eventCollector.js";
import { JsonStore } from "../store/jsonStore.js";
import { FilesystemMonitor } from "../telemetry/filesystemMonitor.js";
import { NetworkProxy, type ControlRequest } from "../telemetry/networkProxy.js";
import { BUILDER_AMENDMENT_INSTRUCTION, type IntentAmendmentService } from "../intent/intentAmendmentService.js";
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
import { RuntimeSetupService } from "./runtimeSetupService.js";
import { ProcessProvider } from "./processProvider.js";
import type { SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { planWorkspaceMounts } from "./sandboxProvider.js";

export interface RuntimeManagerOptions {
  defaultProvider?: RuntimeProviderKind;
  image?: string;
  baseVm?: string;
  workspaceRoot?: string;
  memoryBytes?: number;
  cpuShares?: number;
  pidsLimit?: number;
}

export class RuntimeManager {
  private readonly providers: Record<RuntimeProviderKind, SandboxProvider>;
  readonly setup: RuntimeSetupService;
  private readonly active = new Map<string, { provider?: SandboxProvider; handle?: SandboxHandle; stopping: boolean }>();
  private amendments?: IntentAmendmentService;

  constructor(
    private readonly store: JsonStore,
    private readonly events: EventCollector,
    private readonly options: RuntimeManagerOptions = {}
  ) {
    this.setup = new RuntimeSetupService({ image: options.image, baseVm: options.baseVm });
    this.providers = {
      lima: new LimaProvider({ baseVm: options.baseVm, pidsLimit: options.pidsLimit }),
      docker: new DockerProvider(options, this.setup),
      process: new ProcessProvider()
    };
  }

  /** Enables the in-sandbox control channel (`http://periscope.internal/amendments`) and live grant application. */
  attachAmendments(service: IntentAmendmentService): void {
    this.amendments = service;
  }

  /**
   * Called once at startup. Runs still marked in-flight belong to a previous backend process and
   * can never finish, so they are failed, their sandboxes/networks/VMs removed and their temp
   * workspaces deleted when the run asked for cleanup.
   */
  async recover(): Promise<{ failedRuns: string[]; reaped: Record<RuntimeProviderKind, string[]> }> {
    const inFlight = (await this.store.listRuns()).filter(
      (run) => ["starting", "running", "paused", "stopping"].includes(run.status) && !this.active.has(run.id)
    );
    const failedRuns: string[] = [];
    for (const run of inFlight) {
      await this.store.updateRun(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        failureReason: "Periscope backend restarted while the run was in flight; sandbox torn down"
      });
      await this.events.emitEvent({
        runId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "runtime",
        action: "failed",
        severity: "high",
        metadata: { reason: "backend_restart" }
      });
      if (run.workspacePath && run.cleanupWorkspace) {
        await rm(run.workspacePath, { recursive: true, force: true }).catch(() => undefined);
      }
      failedRuns.push(run.id);
    }

    const activeRunIds = new Set(this.active.keys());
    const reaped: Record<RuntimeProviderKind, string[]> = { docker: [], lima: [], process: [] };
    for (const provider of Object.values(this.providers)) {
      if (!provider.reapOrphans) continue;
      reaped[provider.kind] = await provider.reapOrphans(activeRunIds).catch(() => []);
    }
    return { failedRuns, reaped };
  }

  async createRun(request: CreateRunRequest): Promise<RunRecord> {
    validateCreateRun(request);
    await assertReadableDirectory(request.repo.path);
    if (this.amendments && request.agent?.prompt && (request.purpose ?? "builder") === "builder") {
      request = { ...request, agent: { ...request.agent, prompt: `${request.agent.prompt}\n\n${BUILDER_AMENDMENT_INSTRUCTION}` } };
    }
    const agent = resolveAgent(request);
    const runtimeProvider = request.runtime?.provider ?? this.options.defaultProvider ?? defaultProvider();
    if (request.interactive && runtimeProvider !== "docker") throw new Error("interactive runs require the docker runtime");
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
      workspaceAccess: request.purpose === "planner" ? "read_only" : "read_write",
      purpose: request.purpose ?? "builder",
      parentRunId: request.parentRunId,
      projectId: request.projectId,
      interactive: request.interactive || undefined
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

      const amendments = this.amendments;
      networkProxy = new NetworkProxy(
        run,
        permissions.network ?? [],
        this.events,
        amendments ? (control) => this.handleControl(run, amendments, control) : undefined
      );
      const proxyPort = await networkProxy.start();
      if (amendments) {
        const proxy = networkProxy;
        amendments.registerLiveApplier(run.id, async (grants) => (grants.network?.length && proxy.allow(grants.network) ? ["network"] : []));
      }

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

      provider = this.providers[run.runtimeProvider];
      const mounts = await planWorkspaceMounts(run, workspacePath, permissions);
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
          networkAllowlist: permissions.network ?? [],
          workspaceMount: mounts.root,
          writableMounts: mounts.writable,
          filesystemScope: provider.filesystemScope(mounts),
          agentKind: run.agent?.kind ?? "generic",
          outputTelemetry: "jsonl_with_raw_fallback"
        }
      });

      outputMonitor = new AgentOutputMonitor(run, this.events, {
        filesystemEnforced: provider.filesystemScope(mounts) === "enforced",
        onAmendmentRequest: amendments ? (payload) => amendments.request(run.id, payload, "agent_output").then(() => undefined) : undefined
      });
      const proxyHostname = provider.prepareNetwork ? await provider.prepareNetwork(run) : provider.proxyHostname;
      handle = await provider.create({
        run,
        workspacePath,
        mounts,
        proxyUrl: networkProxy.getProxyUrl(proxyHostname),
        environment: {
          ...agentEnvironment,
          AGENTGUARD_RUN_ID: run.id,
          AGENTGUARD_RUN_PURPOSE: run.purpose ?? "builder",
          AGENTGUARD_WORKSPACE_ACCESS: run.workspaceAccess ?? "read_write"
        },
        onOutput: (output) => outputMonitor?.observe(output),
        onStatus: (message) =>
          void this.events.emitEvent({
            runId: run.id,
            taskId: run.taskId,
            agentId: run.agentId,
            category: "runtime",
            action: "preparing",
            severity: "info",
            metadata: { provider: run.runtimeProvider, message }
          })
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
      let finalStatus: RunStatus = active?.stopping ? "stopped" : exitCode === 0 ? "completed" : "failed";
      let planningViolation: string | undefined;
      if (run.workspaceAccess === "read_only" && gitSummary.files.length > 0) {
        planningViolation = `Planning workspace was modified despite read-only access: ${gitSummary.files.join(", ")}`;
        finalStatus = "failed";
        await this.events.emitEvent({
          runId: run.id,
          taskId: run.taskId,
          agentId: run.agentId,
          category: "runtime",
          action: "planning_workspace_modified",
          severity: "high",
          allowed: false,
          metadata: { files: gitSummary.files }
        });
      }
      await this.store.setGitSummary(run.id, gitSummary);
      await this.store.updateRun(run.id, {
        status: finalStatus,
        completedAt: new Date().toISOString(),
        exitCode,
        failureReason:
          planningViolation ?? (exitCode === 0 || finalStatus === "stopped" ? undefined : `Agent command exited with code ${exitCode}`)
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
      this.amendments?.unregisterLiveApplier(run.id);
      await this.cleanup(run.id, workspacePath, run.cleanupWorkspace, provider, handle);
      if (!handle) await provider?.releaseNetwork?.(run).catch(() => undefined);
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

  /**
   * Control channel the agent reaches through the proxy at `http://periscope.internal`:
   *   POST /amendments            {reason, changes, permissions} -> 201 amendment (run is paused)
   *   GET  /amendments/:id?wait=N  long-polls up to N seconds for the human decision
   */
  private async handleControl(
    run: RunRecord,
    amendments: IntentAmendmentService,
    control: ControlRequest
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(control.path, "http://periscope.internal");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "amendments") return { status: 404, body: { error: "Unknown control endpoint" } };

    if (control.method === "POST" && segments.length === 1) {
      try {
        return { status: 201, body: await amendments.request(run.id, control.body, "control_channel") };
      } catch (error: unknown) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    }
    if (control.method === "GET" && segments.length === 2) {
      const waitSeconds = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 60);
      const amendment = waitSeconds
        ? await amendments.waitForDecision(segments[1], waitSeconds * 1000).catch(() => undefined)
        : await amendments.get(segments[1]);
      if (!amendment || amendment.runId !== run.id) return { status: 404, body: { error: "Amendment not found" } };
      return { status: 200, body: amendment };
    }
    return { status: 405, body: { error: "Method not allowed" } };
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
  if (request.interactive && request.purpose === "planner") throw new Error("interactive runs cannot be planners");
  if (!request.command?.length && !request.agent?.command?.length && !request.agent) {
    throw new Error("command or agent profile is required");
  }
}

function defaultProvider(): RuntimeProviderKind {
  const configured = process.env.AGENTGUARD_RUNTIME_PROVIDER;
  return configured === "docker" || configured === "process" ? configured : "lima";
}

export function resolveSecretEnvironment(permissions: PermissionSnapshot, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const name of permissions.secrets ?? []) {
    const value = source[name];
    if (value !== undefined) secrets[name] = value;
  }
  return secrets;
}
