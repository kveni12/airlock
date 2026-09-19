import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DependencyChange, GitSummary } from "../types.js";

const execFileAsync = promisify(execFile);

const DEPENDENCY_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Cargo.toml",
  "go.mod"
];

export type DependencySnapshot = Record<string, Record<string, string>>;

export async function getGitState(repoPath: string): Promise<GitSummary["before"]> {
  if (!(await isGitRepo(repoPath))) {
    return { branch: null, head: null, dirty: false };
  }

  const [branch, head, status] = await Promise.all([
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
    git(repoPath, ["rev-parse", "HEAD"]).catch(() => ""),
    git(repoPath, ["status", "--porcelain"]).catch(() => "")
  ]);

  return {
    branch: branch.trim() || null,
    head: head.trim() || null,
    dirty: status.trim().length > 0
  };
}

export async function ensureGitBaseline(repoPath: string): Promise<void> {
  if (await isGitRepo(repoPath)) return;

  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "agentguard@example.local"]);
  await git(repoPath, ["config", "user.name", "AgentGuard"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "AgentGuard baseline"]);
}

export async function snapshotDependencies(repoPath: string): Promise<DependencySnapshot> {
  const snapshot: DependencySnapshot = {};
  for (const manifest of DEPENDENCY_MANIFESTS) {
    const manifestPath = path.join(repoPath, manifest);
    try {
      await access(manifestPath);
      const raw = await readFile(manifestPath, "utf8");
      snapshot[manifest] = parseManifest(manifest, raw);
    } catch {
      // Missing manifests are normal for small demo repositories.
    }
  }
  return snapshot;
}

export async function collectGitSummary(
  repoPath: string,
  before: GitSummary["before"],
  dependencyBefore: DependencySnapshot
): Promise<GitSummary> {
  const after = await getGitState(repoPath);
  const diff = (await git(repoPath, ["diff", "--no-ext-diff"]).catch(() => "")).trim();
  const numstat = await git(repoPath, ["diff", "--numstat"]).catch(() => "");
  const changed = await git(repoPath, ["status", "--porcelain"]).catch(() => "");
  const commits = before?.head
    ? (await git(repoPath, ["log", "--format=%H", `${before.head}..HEAD`]).catch(() => ""))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  const files = parseChangedFiles(changed, numstat);
  const stats = parseNumstat(numstat);
  const dependencyAfter = await snapshotDependencies(repoPath);

  return {
    before,
    after,
    filesChanged: files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    files,
    commits,
    dependencyChanges: diffDependencies(dependencyBefore, dependencyAfter),
    diff
  };
}

export async function checkoutBranch(repoPath: string, branch?: string): Promise<void> {
  if (!branch || !(await isGitRepo(repoPath))) return;
  await git(repoPath, ["checkout", branch]);
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

function parseChangedFiles(status: string, numstat: string): string[] {
  const files = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const file = line.slice(3).split(" -> ").pop();
    if (file) files.add(file);
  }
  for (const line of numstat.split("\n")) {
    const [, , file] = line.split("\t");
    if (file) files.add(file);
  }
  return [...files].sort();
}

function parseNumstat(numstat: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const [added, removed] = line.split("\t");
    insertions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(removed, 10) || 0;
  }
  return { insertions, deletions };
}

function parseManifest(manifest: string, raw: string): Record<string, string> {
  if (manifest === "package.json") {
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.optionalDependencies
    };
  }

  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.@/-]+)\s*(?:==|=|\^|~|>=|<=|>|<)?\s*([^,\s"]*)/);
    if (match) entries[match[1]] = match[2] || "";
  }
  return entries;
}

function diffDependencies(before: DependencySnapshot, after: DependencySnapshot): DependencyChange[] {
  const changes: DependencyChange[] = [];
  const manifests = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const manifest of manifests) {
    const previous = before[manifest] ?? {};
    const next = after[manifest] ?? {};
    for (const [name, version] of Object.entries(next)) {
      if (!(name in previous)) {
        changes.push({ type: "dependency_added", name, manifest, after: version });
      }
    }
    for (const [name, version] of Object.entries(previous)) {
      if (!(name in next)) {
        changes.push({ type: "dependency_removed", name, manifest, before: version });
      }
    }
  }
  return changes;
}
