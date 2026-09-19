import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectGitSummary, getGitState, snapshotDependencies } from "../src/telemetry/gitTelemetry.js";

const execFileAsync = promisify(execFile);

describe("git telemetry", () => {
  it("includes exact untracked file paths and their contents in the final diff", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "agentguard-git-"));
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.local"]);
    await git(repo, ["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "baseline\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "baseline"]);
    const before = await getGitState(repo);
    const dependencies = await snapshotDependencies(repo);
    await mkdir(path.join(repo, "infra"));
    await writeFile(path.join(repo, "infra", "prod.tf"), "production = true\n");

    const summary = await collectGitSummary(repo, before, dependencies);
    expect(summary.files).toContain("infra/prod.tf");
    expect(summary.diff).toContain("production = true");
    await rm(repo, { recursive: true, force: true });
  });
});

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}
