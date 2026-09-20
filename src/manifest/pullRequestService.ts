import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JsonStore } from "../store/jsonStore.js";
import type { EventCollector } from "../events/eventCollector.js";
import type { RunPullRequest } from "../types.js";
import { RunManifestService, manifestToMarkdown } from "./runManifestService.js";

const execFileAsync = promisify(execFile);

export interface CreatePullRequestOptions {
  branch?: string;
  /** Push the branch to the repo's remote (default `origin`) after committing. */
  push?: boolean;
  remote?: string;
  title?: string;
  actor?: string;
}

export class PullRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409
  ) {
    super(message);
  }
}

/**
 * Turns an approved run into a git branch on the *source* repository, applying exactly the diff
 * Periscope recorded and reviewed (never the live sandbox or host working tree). The commit message
 * carries the Run Manifest so the audit trail travels with the change.
 *
 * Refuses unless: run completed, review approved, source repo is a git repo, recorded diff non-empty.
 * Works in a temporary worktree so the user's checkout is never touched.
 */
export class PullRequestService {
  constructor(
    private readonly store: JsonStore,
    private readonly manifests: RunManifestService,
    private readonly events: EventCollector
  ) {}

  async createFromApprovedRun(runId: string, options: CreatePullRequestOptions = {}): Promise<RunPullRequest> {
    const run = await this.store.getRun(runId);
    if (!run) throw new PullRequestError(`Run ${runId} not found`, 404);
    if (run.workspaceMode === "local") throw new PullRequestError("This session already edited the local project. Review and commit those changes in your checkout.", 409);
    if (run.pullRequest) throw new PullRequestError(`Run ${runId} already has branch ${run.pullRequest.branch}`, 409);
    if (run.status !== "completed") throw new PullRequestError(`Run ${runId} is ${run.status}; only completed runs can become a pull request`, 409);

    const manifest = await this.manifests.build(runId);
    if (manifest.decision.status !== "approved") {
      throw new PullRequestError(`Run ${runId} review is ${manifest.decision.status.replace("_", " ")}; a human must approve it first`, 409);
    }
    const diff = run.gitSummary?.diff?.trim();
    if (!diff) throw new PullRequestError(`Run ${runId} recorded no diff to turn into a pull request`, 409);

    const repo = run.repoPath;
    if (!(await this.git(repo, ["rev-parse", "--is-inside-work-tree"]).catch(() => null))) {
      throw new PullRequestError(`${repo} is not a git repository`, 409);
    }

    const branch = sanitizeBranch(options.branch ?? `periscope/${runId}`);
    if (await this.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null)) {
      throw new PullRequestError(`Branch ${branch} already exists in ${repo}`, 409);
    }

    const baseHead = run.gitSummary?.before?.head ?? null;
    const base = (baseHead && (await this.git(repo, ["cat-file", "-e", `${baseHead}^{commit}`]).then(() => baseHead).catch(() => null))) || "HEAD";
    const worktree = await mkdtemp(path.join(os.tmpdir(), "periscope-pr-"));
    try {
      await this.git(repo, ["worktree", "add", "--detach", worktree, base]);
      await writeFile(path.join(worktree, ".periscope-run.diff"), `${diff}\n`);
      await this.git(worktree, ["apply", "--index", "--exclude=.periscope-run.diff", ".periscope-run.diff"]).catch((error: Error) => {
        throw new PullRequestError(`Recorded diff does not apply cleanly on ${base.slice(0, 12)}: ${firstLine(error.message)}`, 409);
      });
      await rm(path.join(worktree, ".periscope-run.diff"), { force: true });
      await this.git(worktree, ["checkout", "-b", branch]);

      const title = options.title ?? `Periscope: ${manifest.intent?.goal ?? manifest.request?.prompt ?? `run ${runId}`}`.slice(0, 72);
      const body = manifestToMarkdown(manifest);
      await this.git(worktree, ["-c", "user.name=Periscope", "-c", "user.email=periscope@example.local", "commit", "-q", "-m", title, "-m", body]);
      const commit = (await this.git(worktree, ["rev-parse", "HEAD"])).trim();

      const remote = options.remote ?? "origin";
      let pushed = false;
      let compareUrl: string | undefined;
      if (options.push) {
        await this.git(worktree, ["push", "-u", remote, branch]).catch((error: Error) => {
          throw new PullRequestError(`Branch ${branch} created locally but push to ${remote} failed: ${firstLine(error.message)}`, 409);
        });
        pushed = true;
        const remoteUrl = (await this.git(repo, ["remote", "get-url", remote]).catch(() => "")).trim();
        compareUrl = compareUrlFor(remoteUrl, branch);
      }

      const record: RunPullRequest = {
        branch,
        commit,
        baseHead,
        pushed,
        remote: pushed ? remote : undefined,
        compareUrl,
        createdAt: new Date().toISOString(),
        createdBy: options.actor
      };
      await this.store.updateRun(runId, { pullRequest: record });
      await this.events.emitEvent({
        runId,
        taskId: run.taskId,
        agentId: run.agentId,
        category: "git",
        action: "pull_request_branch_created",
        resource: branch,
        allowed: true,
        severity: "info",
        evidenceSource: "git",
        metadata: { commit, baseHead, pushed, compareUrl, actor: options.actor, files: manifest.behavior.filesChanged.length }
      });
      return record;
    } finally {
      await this.git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  }
}

function sanitizeBranch(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "");
  if (!cleaned || cleaned.includes("..") || cleaned.endsWith(".lock")) {
    throw new PullRequestError(`Invalid branch name: ${name}`, 400);
  }
  return cleaned;
}

function firstLine(message: string): string {
  return message.split("\n").find((line) => line.trim() && !line.startsWith("Command failed"))?.trim() ?? message.trim();
}

export function compareUrlFor(remoteUrl: string, branch: string): string | undefined {
  const match = remoteUrl.match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, host, owner, repo] = match;
  if (host.includes("gitlab")) return `https://${host}/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
  return `https://${host}/${owner}/${repo}/compare/${encodeURIComponent(branch)}?expand=1`;
}
