import Docker from "dockerode";
import type { Container } from "dockerode";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider, WorkspaceMounts } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";
import { LineDecoder } from "../telemetry/lineDecoder.js";
import type { RunRecord } from "../types.js";
import type { RuntimeSetupService } from "./runtimeSetupService.js";

interface DockerHandle extends SandboxHandle {
  container: Container;
  networkName?: string;
  onOutput?: SandboxCreateOptions["onOutput"];
  stdoutDecoder?: LineDecoder;
  stderrDecoder?: LineDecoder;
  tty?: boolean;
}

export interface DockerProviderOptions {
  memoryBytes?: number;
  cpuShares?: number;
  pidsLimit?: number;
  /** Host running Periscope when Docker itself lives in a VM (e.g. host.docker.internal). */
  proxyHost?: string;
}

export const RUN_LABEL = "agentguard.run";

export class DockerProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly proxyHostname = "host.docker.internal";
  private readonly docker = new Docker();
  private readonly networks = new Map<string, { name: string; gateway: string; relay?: Container }>();

  constructor(
    private readonly options: DockerProviderOptions = {},
    private readonly setup?: RuntimeSetupService
  ) {}

  filesystemScope(): "enforced" {
    return "enforced";
  }

  /**
   * Each run gets its own `internal` bridge network: Docker gives it no route to the outside
   * world, so the only way out is the Periscope proxy listening on the host at the bridge gateway.
   * Agents that ignore HTTP(S)_PROXY therefore get "network unreachable" instead of a bypass.
   */
  async prepareNetwork(run: RunRecord, proxyPort: number): Promise<string> {
    const name = `agentguard-net-${run.id}`;
    const network = await this.docker.createNetwork({ Name: name, Driver: "bridge", Internal: true, Labels: { [RUN_LABEL]: run.id } });
    const info = await network.inspect() as { IPAM?: { Config?: Array<{ Gateway?: string }> } };
    const gateway = info.IPAM?.Config?.find((config) => config.Gateway)?.Gateway;
    if (!gateway) {
      await network.remove().catch(() => undefined);
      throw new Error(`Docker did not assign a gateway to network ${name}`);
    }
    this.networks.set(run.id, { name, gateway });
    const proxyHost = this.options.proxyHost ?? process.env.AGENTGUARD_DOCKER_PROXY_HOST;
    if (proxyHost) {
      // On macOS the bridge gateway belongs to the Docker VM, not the process
      // running Periscope. A separate, mount-free relay reaches the host proxy.
      // Only the relay joins the outbound bridge; the agent remains internal.
      const image = run.runtimeImage ?? "agentguard-runtime:latest";
      try {
        if (this.setup) await this.setup.ensureImage(image);
        const relay = await this.docker.createContainer({
          Image: image,
          name: `agentguard-proxy-${run.id}`,
          Labels: { [RUN_LABEL]: run.id },
          User: containerUser(),
          WorkingDir: "/tmp",
          Entrypoint: ["node"],
          Cmd: ["-e", PROXY_RELAY_SCRIPT, proxyHost, String(proxyPort)],
          HostConfig: {
            NetworkMode: "bridge", ReadonlyRootfs: true, CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"], Memory: 64 * 1024 * 1024, PidsLimit: 32
          }
        });
        this.networks.set(run.id, { name, gateway, relay });
        await network.connect({ Container: relay.id });
        await relay.start();
        // Don't race the agent against the relay's listen(). Its only log is a
        // readiness marker, so this bounded poll is independent of network/API availability.
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const log = await relay.logs({ stdout: true, stderr: false, tail: 1 });
          if (String(log).includes("periscope-proxy-ready")) { ready = true; break; }
          const state = await relay.inspect();
          if (!state.State.Running) throw new Error("Docker proxy relay exited before becoming ready");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error("Docker proxy relay did not become ready");
        const state = await relay.inspect();
        const address = state.NetworkSettings.Networks[name]?.IPAddress;
        if (!address) throw new Error("Docker proxy relay has no internal-network address");
        return address;
      } catch (error) {
        await this.releaseNetwork(run);
        throw error;
      }
    }
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
    await network.relay?.remove({ force: true }).catch(() => undefined);
    await this.docker.getNetwork(network.name).remove().catch(() => undefined);
  }

  async create(options: SandboxCreateOptions): Promise<DockerHandle> {
    const { run, workspacePath, proxyUrl, environment, mounts } = options;
    const name = `agentguard-${run.id}`;
    const user = containerUser();
    const env = { HOME: "/tmp", ...runtimeEnvironment(proxyUrl), ...environment };
    const network = this.networks.get(run.id);
    const binds = dockerBinds(workspacePath, mounts);
    const image = run.runtimeImage ?? "agentguard-runtime:latest";
    if (this.setup && !(await this.setup.imagePresent(image))) {
      options.onStatus?.(`Docker image ${image} is missing — building it from runtime/Dockerfile (first run only, may take a few minutes).`);
      await this.setup.ensureImage(image);
      options.onStatus?.(`Docker image ${image} built.`);
    }
    const container = await this.docker.createContainer({
      Image: image,
      name,
      Cmd: run.command,
      Labels: { [RUN_LABEL]: run.id },
      ...(run.interactive ? { Tty: true, OpenStdin: true, StdinOnce: false, AttachStdin: true } : {}),
      User: user,
      WorkingDir: "/workspace",
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        AutoRemove: false,
        Binds: binds,
        Tmpfs: Object.fromEntries(mounts.maskedDirectories.map((relative) => [path.posix.join("/workspace", relative), "ro,nosuid,nodev,noexec,size=64k"])),
        MaskedPaths: mounts.maskedFiles.map((relative) => path.posix.join("/workspace", relative)),
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
    return { id: container.id, name, container, networkName: network?.name, onOutput: options.onOutput, tty: Boolean(run.interactive) };
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
    // A TTY container has one multiplexed stream (no stdout/stderr framing).
    if (docker.tty) output.on("data", (chunk: Buffer) => stdout.write(chunk));
    else docker.container.modem.demuxStream(output, stdout, stderr);
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
      for (const network of this.networks.values()) {
        if (network.name === docker.networkName) await network.relay?.remove({ force: true }).catch(() => undefined);
      }
      await this.docker.getNetwork(docker.networkName).remove().catch(() => undefined);
      for (const [runId, network] of this.networks) if (network.name === docker.networkName) this.networks.delete(runId);
    }
  }
}

// No credentials or workspace mounts in this container. It forwards only to
// this run's existing policy proxy; it cannot choose another upstream per request.
const PROXY_RELAY_SCRIPT = `
const net = require('node:net');
const [host, port] = process.argv.slice(1);
net.createServer(client => {
  const upstream = net.connect(Number(port), host);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream); upstream.pipe(client);
}).listen(Number(port), '0.0.0.0', () => console.log('periscope-proxy-ready'));
`;

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

/** Bind only visible paths. Nested binds let a child override its parent's access. */
export function dockerBinds(workspacePath: string, mounts: WorkspaceMounts): string[] {
  const binds: string[] = [];
  if (mounts.root !== "none") binds.push(`${workspacePath}:/workspace${mounts.root === "ro" ? ":ro" : ""}`);
  const hostPath = (relative: string) => /^[A-Za-z]:[\\/]/.test(workspacePath)
    ? path.win32.join(workspacePath, relative)
    : path.posix.join(workspacePath.replace(/\\/g, "/"), relative);
  for (const relative of mounts.readonly) {
    binds.push(`${hostPath(relative)}:${path.posix.join("/workspace", relative)}:ro`);
  }
  for (const relative of mounts.writable) {
    binds.push(`${hostPath(relative)}:${path.posix.join("/workspace", relative)}`);
  }
  return binds;
}
