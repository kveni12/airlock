import Docker from "dockerode";
import type { Container } from "dockerode";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";

interface DockerHandle extends SandboxHandle {
  container: Container;
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
        Binds: [`${workspacePath}:/workspace`],
        Memory: this.options.memoryBytes ?? 512 * 1024 * 1024,
        CpuShares: this.options.cpuShares ?? 512,
        PidsLimit: this.options.pidsLimit ?? 256,
        Privileged: false,
        NetworkMode: "bridge",
        ReadonlyRootfs: false
      }
    });
    return { id: container.id, name, container };
  }

  async start(handle: SandboxHandle): Promise<void> {
    await asDockerHandle(handle).container.start();
  }

  async wait(handle: SandboxHandle): Promise<{ exitCode: number | null }> {
    const result = await asDockerHandle(handle).container.wait();
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
