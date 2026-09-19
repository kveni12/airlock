import Docker from "dockerode";
import type { Container } from "dockerode";
import { PassThrough } from "node:stream";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";
import { LineDecoder } from "../telemetry/lineDecoder.js";

interface DockerHandle extends SandboxHandle {
  container: Container;
  onOutput?: SandboxCreateOptions["onOutput"];
  stdoutDecoder?: LineDecoder;
  stderrDecoder?: LineDecoder;
}

export interface DockerProviderOptions {
  memoryBytes?: number;
  cpuShares?: number;
  pidsLimit?: number;
}

export class DockerProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly proxyHostname = "host.docker.internal";
  private readonly docker = new Docker();

  constructor(private readonly options: DockerProviderOptions = {}) {}

  async create(options: SandboxCreateOptions): Promise<DockerHandle> {
    const { run, workspacePath, proxyUrl, environment } = options;
    const name = `agentguard-${run.id}`;
    const env = { ...runtimeEnvironment(proxyUrl), ...environment };
    const container = await this.docker.createContainer({
      Image: run.runtimeImage ?? "agentguard-runtime:latest",
      name,
      Cmd: run.command,
      WorkingDir: "/workspace",
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        AutoRemove: false,
        Binds: [run.workspaceAccess === "read_only" ? `${workspacePath}:/workspace:ro` : `${workspacePath}:/workspace`],
        Memory: this.options.memoryBytes ?? 512 * 1024 * 1024,
        CpuShares: this.options.cpuShares ?? 512,
        PidsLimit: this.options.pidsLimit ?? 256,
        Privileged: false,
        NetworkMode: "bridge",
        ReadonlyRootfs: false
      }
    });
    return { id: container.id, name, container, onOutput: options.onOutput };
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
    await asDockerHandle(handle).container.remove({ force: true }).catch(() => undefined);
  }
}

function asDockerHandle(handle: SandboxHandle): DockerHandle {
  return handle as DockerHandle;
}
