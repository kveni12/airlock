import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { AGENT_PROFILES } from "../agents/agentAdapter.js";

export const DEFAULT_RUNTIME_IMAGE = "agentguard-runtime:latest";
export const DEFAULT_BASE_VM = "agentguard-base";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface RuntimeStatus {
  docker: { available: boolean; image: string; imagePresent: boolean; detail?: string };
  lima: { available: boolean; baseVm: string; baseVmPresent: boolean; agentVms: Record<string, { vm: string; present: boolean }>; detail?: string };
  process: { available: true; sandboxed: false };
}

export type SetupTarget = { provider: "docker" } | { provider: "lima"; agent?: string };

export interface SetupJob {
  id: string;
  target: SetupTarget;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  log: string[];
}

const MAX_LOG_LINES = 2000;

/** Reports whether each sandbox runtime is usable on this machine and runs the repo's setup scripts on request. */
export class RuntimeSetupService {
  private readonly docker = new Docker();
  private readonly jobs = new Map<string, SetupJob>();
  private imageBuild?: Promise<void>;

  constructor(private readonly options: { image?: string; baseVm?: string } = {}) {}

  get image(): string {
    return this.options.image ?? DEFAULT_RUNTIME_IMAGE;
  }

  get baseVm(): string {
    return this.options.baseVm ?? DEFAULT_BASE_VM;
  }

  async status(): Promise<RuntimeStatus> {
    const [docker, lima] = await Promise.all([this.dockerStatus(), this.limaStatus()]);
    return { docker, lima, process: { available: true, sandboxed: false } };
  }

  async imagePresent(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Builds the default runtime image from runtime/Dockerfile if it is missing. Concurrent callers share one build. */
  async ensureImage(image: string, onLog?: (line: string) => void): Promise<"present" | "built"> {
    if (await this.imagePresent(image)) return "present";
    if (image !== this.image) throw new Error(`Docker image '${image}' is not available locally and is not the default runtime image, so Periscope will not build it. Pull or build it first.`);
    this.imageBuild ??= this.runBuild(onLog).finally(() => {
      this.imageBuild = undefined;
    });
    await this.imageBuild;
    return "built";
  }

  startSetup(target: SetupTarget): SetupJob {
    const job: SetupJob = { id: `setup_${randomUUID().slice(0, 8)}`, target, status: "running", startedAt: new Date().toISOString(), log: [] };
    this.jobs.set(job.id, job);
    const [command, args] = setupCommand(target, this.image);
    const child = spawn(command, args, { cwd: REPO_ROOT, env: { ...process.env, AGENTGUARD_BASE_VM: this.baseVm } });
    const push = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        job.log.push(line);
        if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (error) => {
      job.log.push(`failed to start: ${error.message}`);
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
    });
    child.on("close", (code) => {
      job.exitCode = code;
      job.status = code === 0 ? "succeeded" : "failed";
      job.finishedAt = new Date().toISOString();
    });
    return job;
  }

  getJob(id: string): SetupJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): SetupJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private async runBuild(onLog?: (line: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["build", "-t", this.image, "-f", "runtime/Dockerfile", "."], { cwd: REPO_ROOT });
      let tail = "";
      const push = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line) continue;
          tail = line;
          onLog?.(line);
        }
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited with ${code}: ${tail}`))));
    });
  }

  private async dockerStatus(): Promise<RuntimeStatus["docker"]> {
    try {
      await this.docker.ping();
    } catch (error) {
      return { available: false, image: this.image, imagePresent: false, detail: `Docker daemon not reachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { available: true, image: this.image, imagePresent: await this.imagePresent(this.image) };
  }

  private async limaStatus(): Promise<RuntimeStatus["lima"]> {
    const agentVms: RuntimeStatus["lima"]["agentVms"] = {};
    for (const profile of AGENT_PROFILES) agentVms[profile.kind] = { vm: profile.defaultBaseVm, present: false };
    const list = await limaList();
    if (!list.ok) return { available: false, baseVm: this.baseVm, baseVmPresent: false, agentVms, detail: list.detail };
    for (const entry of Object.values(agentVms)) entry.present = list.names.has(entry.vm);
    return { available: true, baseVm: this.baseVm, baseVmPresent: list.names.has(this.baseVm), agentVms };
  }
}

function setupCommand(target: SetupTarget, image: string): [string, string[]] {
  if (target.provider === "docker") return ["docker", ["build", "-t", image, "-f", "runtime/Dockerfile", "."]];
  if (target.agent) return ["bash", ["scripts/setup-agent-runtime.sh", target.agent]];
  return ["bash", ["scripts/setup-vm-runtime.sh"]];
}

async function limaList(): Promise<{ ok: true; names: Set<string> } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("limactl", ["list", "--format", "{{.Name}}"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (error) => resolve({ ok: false, detail: error.message.includes("ENOENT") ? "limactl is not installed (macOS: brew install lima)." : error.message }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, detail: err.trim() || `limactl exited with ${code}` });
      resolve({ ok: true, names: new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) });
    });
  });
}
