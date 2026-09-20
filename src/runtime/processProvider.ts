import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { LineDecoder } from "../telemetry/lineDecoder.js";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./sandboxProvider.js";
import { runtimeEnvironment } from "./sandboxProvider.js";

const PASSTHROUGH_HOST_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "COMSPEC", "PATHEXT"];

export function baseHostEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_HOST_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface HostProcessCommand {
  executable: string;
  args: string[];
}

/** Translate the API's portable shell wrapper to the shell available on the backend host. */
export function processCommandForHost(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec
): HostProcessCommand {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Process command is empty");

  if (platform === "win32" && (executable === "/bin/sh" || executable === "sh") && (args[0] === "-c" || args[0] === "-lc")) {
    const commandText = args[1];
    if (commandText === undefined) throw new Error(`${executable} ${args[0]} requires a command string`);
    return { executable: comspec || "cmd.exe", args: ["/d", "/s", "/c", commandText] };
  }

  if (platform === "win32" && executable.toLowerCase().endsWith(".sh")) {
    return { executable: "bash", args: [executable, ...args] };
  }

  return { executable, args };
}

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
 *
 * The child does NOT inherit the host environment: only PATH/HOME/locale basics plus the
 * environment Periscope resolved for the run (granted secrets, agent config) are passed, so host
 * API keys are not silently visible to the agent.
 */
export class ProcessProvider implements SandboxProvider {
  readonly kind = "process" as const;

  filesystemScope(): "observed" {
    return "observed";
  }
  readonly proxyHostname = "127.0.0.1";

  async create(options: SandboxCreateOptions): Promise<ProcessHandle> {
    return { id: `process-${options.run.id}`, name: `agentguard-${options.run.id}`, options };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const proc = handle as ProcessHandle;
    const { run, workspacePath, proxyUrl, environment, onOutput } = proc.options;
    const command = processCommandForHost(run.command);
    const child = spawn(command.executable, command.args, {
      cwd: workspacePath,
      env: {
        ...baseHostEnvironment(),
        ...runtimeEnvironment(proxyUrl),
        ...environment,
        PATH: `${path.resolve("runtime/bin")}${path.delimiter}${path.resolve("runtime")}${path.delimiter}${process.env.PATH ?? ""}`,
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
