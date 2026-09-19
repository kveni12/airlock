import Docker from "dockerode";
import type { Container } from "dockerode";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider, WorkspaceMounts } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";
import { LineDecoder } from "../telemetry/lineDecoder.js";
import type { RunRecord } from "../types.js";

interface DockerHandle extends SandboxHandle {
  container: Container;
  networkName?: string;
  onOutput?: SandboxCreateOptions["onOutput"];
  stdoutDecoder?: LineDecoder;
  stderrDecoder?: LineDecoder;
}

export interface DockerProviderOptions {
  memoryBytes?: number;
  cpuShares?: number;
  pidsLimit?: number;
}

export const RUN_LABEL = "agentguard.run";

export class DockerProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly proxyHostname = "host.docker.internal";
  private readonly docker = new Docker();
  private readonly networks = new Map<string, { name: string; gateway: string }>();

  constructor(private readonly options: DockerProviderOptions = {}) {}

  filesystemScope(): "enforced" {
    return "enforced";
  }

  /**
   * Each run gets its own `internal` bridge network: Docker gives it no route to the outside
   * world, so the only way out is the Periscope proxy listening on the host at the bridge gateway.
   * Agents that ignore HTTP(S)_PROXY therefore get "network unreachable" instead of a bypass.
   */
  async prepareNetwork(run: RunRecord): Promise<string> {
    const name = `agentguard-net-${run.id}`;
    const network = await this.docker.createNetwork({ Name: name, Driver: "bridge", Internal: true, Labels: { [RUN_LABEL]: run.id } });
    const info = await network.inspect() as { IPAM?: { Config?: Array<{ Gateway?: string }> } };
    const gateway = info.IPAM?.Config?.find((config) => config.Gateway)?.Gateway;
    if (!gateway) {
      await network.remove().catch(() => undefined);
      throw new Error(`Docker did not assign a gateway to network ${name}`);
    }
    this.networks.set(run.id, { name, gateway });
    return gateway;
  }

  /**
   * Remove containers and networks labelled with a run id that is no longer active
   * (left behind when the backend died mid-run). Returns the run ids that were cleaned up.
   */
  async reapOrphans(activeRunIds: Set<string>): Promise<string[]> {
    const reaped = new Set<string>();
    const containers = await this.docker.listContainers({ all: true, filters: { label: [RUN_LABEL] } }).catch(() => []);
    for (const info of containers) {
      const runId = info.Labels?.[RUN_LABEL];
      if (!runId || activeRunIds.has(runId)) continue;
      await this.docker.getContainer(info.Id).remove({ force: true }).catch(() => undefined);
      reaped.add(runId);
    }
    const networks = await this.docker.listNetworks({ filters: { label: [RUN_LABEL] } }).catch(() => []);
    for (const info of networks) {
      const runId = info.Labels?.[RUN_LABEL];
      if (!runId || activeRunIds.has(runId)) continue;
      await this.docker.getNetwork(info.Id).remove().catch(() => undefined);
      reaped.add(runId);
    }
    return [...reaped];
  }

  async releaseNetwork(run: RunRecord): Promise<void> {
    const network = this.networks.get(run.id);
    if (!network) return;
    this.networks.delete(run.id);
    await this.docker.getNetwork(network.name).remove().catch(() => undefined);
  }

  async create(options: SandboxCreateOptions): Promise<DockerHandle> {
    const { run, workspacePath, proxyUrl, environment, mounts } = options;
    const name = `agentguard-${run.id}`;
    const user = containerUser();
    const env = { HOME: "/tmp", ...runtimeEnvironment(proxyUrl), ...environment };
    const network = this.networks.get(run.id);
    const binds = dockerBinds(workspacePath, mounts);
    const container = await this.docker.createContainer({
      Image: run.runtimeImage ?? "agentguard-runtime:latest",
      name,
      Cmd: run.command,
      Labels: { [RUN_LABEL]: run.id },
      User: user,
      WorkingDir: "/workspace",
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        AutoRemove: false,
        Binds: binds,
        Memory: this.options.memoryBytes ?? 512 * 1024 * 1024,
        CpuShares: this.options.cpuShares ?? 512,
        PidsLimit: this.options.pidsLimit ?? 256,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        NetworkMode: network?.name ?? "none",
        ReadonlyRootfs: false
      }
    });
    return { id: container.id, name, container, networkName: network?.name, onOutput: options.onOutput };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const docker = asDockerHandle(handle);
    const output = await docker.container.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.stdoutDecoder = new LineDecoder("stdout", (line) => docker.onOutput?.(line));
    docker.stderrDecoder = new LineDecoder("stderr", (line) => docker.onOutput?.(line));
    stdout.on("data", (chunk: Buffer) => docker.stdoutDecoder?.write(chunk));
    stderr.on("data", (chunk: Buffer) => docker.stderrDecoder?.write(chunk));
    docker.container.modem.demuxStream(output, stdout, stderr);
    await docker.container.start();
  }

  async wait(handle: SandboxHandle): Promise<{ exitCode: number | null }> {
    const docker = asDockerHandle(handle);
    const result = await docker.container.wait();
    docker.stdoutDecoder?.flush();
    docker.stderrDecoder?.flush();
    return { exitCode: result.StatusCode ?? null };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await asDockerHandle(handle).container.stop({ t: 5 }).catch(() => undefined);
  }

  async remove(handle: SandboxHandle): Promise<void> {
    const docker = asDockerHandle(handle);
    await docker.container.remove({ force: true }).catch(() => undefined);
    if (docker.networkName) {
      await this.docker.getNetwork(docker.networkName).remove().catch(() => undefined);
      for (const [runId, network] of this.networks) if (network.name === docker.networkName) this.networks.delete(runId);
    }
  }
}

/**
 * Run as the host user that owns the workspace copy rather than root: with all capabilities
 * dropped the process can only touch what the bind-mount permissions already allow it to.
 */
function containerUser(): string | undefined {
  if (!process.getuid || !process.getgid) return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

function asDockerHandle(handle: SandboxHandle): DockerHandle {
  return handle as DockerHandle;
}

/** Root bind read-only with each read_write grant layered on top as a writable bind of the same path. */
export function dockerBinds(workspacePath: string, mounts: WorkspaceMounts): string[] {
  const binds = [`${workspacePath}:/workspace${mounts.root === "ro" ? ":ro" : ""}`];
  if (mounts.root === "ro") {
    for (const relative of mounts.writable) binds.push(`${path.join(workspacePath, relative)}:${path.posix.join("/workspace", relative)}`);
  }
  return binds;
}
