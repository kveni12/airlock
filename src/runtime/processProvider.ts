import { spawn, type ChildProcess } from "node:child_process";
import { LineDecoder } from "../telemetry/lineDecoder.js";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";

interface ProcessHandle extends SandboxHandle {
  options: SandboxCreateOptions;
  child?: ChildProcess;
  exit?: Promise<{ exitCode: number | null }>;
}

/**
 * Runs the agent as a local child process inside the temporary workspace copy.
 *
 * This provider offers NO isolation: no VM, no container, no read-only mount. It exists so the
 * full telemetry/finding/review pipeline can run deterministically on hosts without Lima or
 * Docker (demos, CI). It must be selected explicitly and should never be used for untrusted agents.
 * Read-only planning is enforced only by the post-run Git modification check in RuntimeManager.
 */
export class ProcessProvider implements SandboxProvider {
  readonly kind = "process" as const;
  readonly proxyHostname = "127.0.0.1";

  async create(options: SandboxCreateOptions): Promise<ProcessHandle> {
    return { id: `process-${options.run.id}`, name: `agentguard-${options.run.id}`, options };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const proc = handle as ProcessHandle;
    const { run, workspacePath, proxyUrl, environment, onOutput } = proc.options;
    const [command, ...args] = run.command;
    const child = spawn(command, args, {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...runtimeEnvironment(proxyUrl),
        ...environment,
        AGENTGUARD_WORKSPACE: workspacePath,
        AGENTGUARD_WORKSPACE_ACCESS: run.workspaceAccess ?? "read_write"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = new LineDecoder("stdout", (line) => onOutput?.(line));
    const stderr = new LineDecoder("stderr", (line) => onOutput?.(line));
    child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
    proc.child = child;
    proc.exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        stdout.flush();
        stderr.flush();
        resolve({ exitCode: code });
      });
    });
  }

  async wait(handle: SandboxHandle): Promise<{ exitCode: number | null }> {
    const proc = handle as ProcessHandle;
    if (!proc.exit) throw new Error("Process was not started");
    return proc.exit;
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const child = (handle as ProcessHandle).child;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  async remove(): Promise<void> {
    // Nothing to remove: the workspace copy is owned by RuntimeManager.
  }
}
