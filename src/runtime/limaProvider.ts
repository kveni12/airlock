import { spawn, type ChildProcess } from "node:child_process";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";

interface LimaHandle extends SandboxHandle {
  process?: ChildProcess;
  result?: Promise<{ exitCode: number | null }>;
  command: string[];
  environment: Record<string, string>;
  workspacePath: string;
}

export interface LimaProviderOptions {
  binary?: string;
  baseVm?: string;
  cpus?: number;
  memoryGiB?: number;
  pidsLimit?: number;
}

export class LimaProvider implements SandboxProvider {
  readonly kind = "lima" as const;
  readonly proxyHostname = "host.lima.internal";

  constructor(private readonly options: LimaProviderOptions = {}) {}

  async create(options: SandboxCreateOptions): Promise<LimaHandle> {
    const name = limaName(options.run.id);
    const baseVm = options.run.runtimeBaseVm ?? this.options.baseVm ?? "agentguard-base";
    await runCommand(this.binary, ["list", baseVm, "--format", "json"], `Lima base VM '${baseVm}' is unavailable. Run npm run vm:setup first.`);
    await runCommand(
      this.binary,
      [
        "clone",
        baseVm,
        name,
        "--mount-only",
        `${options.workspacePath}:w`,
        "--mount-inotify",
        "--cpus",
        String(this.options.cpus ?? 2),
        "--memory",
        String(this.options.memoryGiB ?? 2)
      ],
      `Failed to clone Lima base VM '${baseVm}'`
    );

    return {
      id: name,
      name,
      command: options.run.command,
      environment: { ...runtimeEnvironment(options.proxyUrl), ...options.environment },
      workspacePath: options.workspacePath
    };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const lima = asLimaHandle(handle);
    await runCommand(this.binary, ["start", lima.name], `Failed to start Lima VM '${lima.name}'`);
    await runCommand(
      this.binary,
      ["shell", lima.name, "sudo", "ln", "-sfn", lima.workspacePath, "/workspace"],
      `Failed to prepare /workspace in Lima VM '${lima.name}'`
    );
    const envArgs = Object.entries(lima.environment).map(([key, value]) => `${key}=${value}`);
    const child = spawn(
      this.binary,
      [
        "shell",
        "--workdir",
        "/workspace",
        lima.name,
        "prlimit",
        `--nproc=${this.options.pidsLimit ?? 256}:${this.options.pidsLimit ?? 256}`,
        "--",
        "env",
        ...envArgs,
        ...lima.command
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    lima.process = child;
    lima.result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) reject(new Error(`Agent process in ${lima.name} terminated by ${signal}: ${stderr.trim()}`));
        else resolve({ exitCode: code });
      });
    });
  }

  async wait(handle: SandboxHandle): Promise<{ exitCode: number | null }> {
    const result = asLimaHandle(handle).result;
    if (!result) throw new Error("Lima VM command was not started");
    return result;
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const lima = asLimaHandle(handle);
    lima.process?.kill("SIGTERM");
    await runCommand(this.binary, ["stop", "--force", lima.name], undefined, true);
  }

  async remove(handle: SandboxHandle): Promise<void> {
    await runCommand(this.binary, ["delete", "--force", handle.name], undefined, true);
  }

  private get binary(): string {
    return this.options.binary ?? "limactl";
  }
}

function limaName(runId: string): string {
  return `agentguard-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

function asLimaHandle(handle: SandboxHandle): LimaHandle {
  return handle as LimaHandle;
}

async function runCommand(
  binary: string,
  args: string[],
  errorPrefix?: string,
  ignoreFailure = false
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.once("error", (error) => {
      if (ignoreFailure) resolve();
      else reject(new Error(`${errorPrefix ?? "Lima command failed"}: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0 || ignoreFailure) resolve();
      else reject(new Error(`${errorPrefix ?? "Lima command failed"}: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}
