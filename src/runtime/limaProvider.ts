import { spawn, type ChildProcess } from "node:child_process";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider, WorkspaceMounts } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";
import { LineDecoder } from "../telemetry/lineDecoder.js";

interface LimaHandle extends SandboxHandle {
  process?: ChildProcess;
  result?: Promise<{ exitCode: number | null }>;
  command: string[];
  environment: Record<string, string>;
  workspacePath: string;
  onOutput?: SandboxCreateOptions["onOutput"];
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

  filesystemScope(mounts: WorkspaceMounts): "enforced" | "observed" {
    return mounts.root === "ro" && mounts.writable.length === 0 ? "enforced" : "observed";
  }

  async isBaseAvailable(baseVm: string): Promise<boolean> {
    try {
      await runCommand(this.binary, ["list", baseVm, "--format", "json"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete per-run VMs (named after the run id) whose run is no longer active. */
  async reapOrphans(activeRunIds: Set<string>): Promise<string[]> {
    let listed: string;
    try {
      listed = await runCommand(this.binary, ["list", "--format", "{{.Name}}"]);
    } catch {
      return [];
    }
    const reaped: string[] = [];
    for (const name of listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      const runId = runIdFromLimaName(name);
      if (!runId || activeRunIds.has(runId)) continue;
      await runCommand(this.binary, ["delete", "--force", name], undefined, true);
      reaped.push(runId);
    }
    return reaped;
  }

  async create(options: SandboxCreateOptions): Promise<LimaHandle> {
    const name = limaName(options.run.id);
    const baseVm = options.run.runtimeBaseVm ?? this.options.baseVm ?? "agentguard-base";
    await runCommand(this.binary, ["list", baseVm, "--format", "json"], `Lima base VM '${baseVm}' is unavailable. Run npm run vm:setup first.`);
    // Lima mounts are host-path-shaped and must not overlap, so per-folder writable overlays cannot be
    // expressed: the whole workspace is read-only (planner) or writable, and out-of-scope writes are
    // caught afterwards in the writable case (see filesystemScope).
    const mountArgs = ["--mount-only", limaMountSpec(options.workspacePath, options.mounts)];
    await runCommand(
      this.binary,
      [
        "clone",
        baseVm,
        name,
        ...mountArgs,
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
      workspacePath: options.workspacePath,
      onOutput: options.onOutput
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
    await runCommand(
      this.binary,
      [
        "shell",
        lima.name,
        "sh",
        "-c",
        'command -v "$1" >/dev/null 2>&1',
        "agentguard-preflight",
        lima.command[0]
      ],
      `Agent executable '${lima.command[0]}' is not installed in Lima base '${lima.name}'. Build the matching base with npm run vm:setup-agent -- <agent>`
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
    const stdoutDecoder = new LineDecoder("stdout", (output) => lima.onOutput?.(output));
    const stderrDecoder = new LineDecoder("stderr", (output) => lima.onOutput?.(output));
    child.stdout?.on("data", (chunk: Buffer) => stdoutDecoder.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
      stderrDecoder.write(chunk);
    });
    lima.process = child;
    lima.result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        stdoutDecoder.flush();
        stderrDecoder.flush();
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

/** Inverse of limaName for per-run VMs (`agentguard-run-<hex>`); base VMs such as `agentguard-base` yield undefined. */
export function runIdFromLimaName(name: string): string | undefined {
  const match = /^agentguard-run-([a-f0-9]+)$/.exec(name);
  return match ? `run_${match[1]}` : undefined;
}

function asLimaHandle(handle: SandboxHandle): LimaHandle {
  return handle as LimaHandle;
}

async function runCommand(
  binary: string,
  args: string[],
  errorPrefix?: string,
  ignoreFailure = false
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-65_536);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.once("error", (error) => {
      if (ignoreFailure) resolve(stdout);
      else reject(new Error(`${errorPrefix ?? "Lima command failed"}: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0 || ignoreFailure) resolve(stdout);
      else reject(new Error(`${errorPrefix ?? "Lima command failed"}: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}

/** `<host path>` mounts read-only, `<host path>:w` writable; a partial overlay widens to writable. */
export function limaMountSpec(workspacePath: string, mounts: WorkspaceMounts): string {
  return mounts.root === "ro" && mounts.writable.length === 0 ? workspacePath : `${workspacePath}:w`;
}
