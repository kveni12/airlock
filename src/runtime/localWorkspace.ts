import { cp, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PermissionSnapshot } from "../types.js";
import { collectGitSummary, ensureGitBaseline, getGitState, snapshotDependencies } from "../telemetry/gitTelemetry.js";
import { relativeGrantPath } from "./sandboxProvider.js";

/** Local mode deliberately supports exact directory grants, not widened globs or nested denials. */
export async function validateLocalScope(root: string, permissions: PermissionSnapshot): Promise<void> {
  const grants = permissions.filesystem ?? [];
  if (!grants.length) throw new Error("Local sessions require explicit filesystem permissions");
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Select a project folder, not a file");
  const writable = grants.filter((grant) => grant.access === "read_write");
  for (const grant of writable) {
    if (/[?*\[\]]/.test(grant.path)) throw new Error("Local writable grants must be exact existing directories, not globs");
    const relative = relativeGrantPath(grant.path);
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error("Local sessions require a read-only workspace root and explicit writable subdirectories");
    }
    if (relative.split("/").includes(".git")) throw new Error("Local sessions keep Git metadata read-only");
    const target = path.join(canonical, relative);
    const resolved = await realpath(target).catch(() => { throw new Error(`Create the granted directory first: ${grant.path}`); });
    if (!resolved.startsWith(canonical + path.sep) || !(await lstat(target)).isDirectory()) {
      throw new Error(`Local writable grant must be a real directory inside the project: ${grant.path}`);
    }
    if (grants.some((other) => other.access === "read" && (relativeGrantPath(other.path) === relative || relativeGrantPath(other.path).startsWith(relative + "/")))) {
      throw new Error(`A read-only child of writable ${grant.path} cannot be enforced; grant narrower writable folders`);
    }
  }
}

/** Compare against session-start contents without initializing, staging, or checking out the real repo. */
export class LocalWorkspaceAudit {
  private constructor(readonly directory: string, private readonly source: string) {}

  static async create(source: string): Promise<LocalWorkspaceAudit> {
    const audit = new LocalWorkspaceAudit(await mkdtemp(path.join(os.tmpdir(), "periscope-local-audit-")), source);
    try {
      await audit.copySource();
      // A project can ignore all its files; the private audit must still capture them.
      await ensureGitBaseline(audit.directory, true);
      return audit;
    } catch (error) { await audit.dispose(); throw error; }
  }

  async finish() {
    const before = await getGitState(this.directory);
    const dependencies = await snapshotDependencies(this.directory);
    for (const entry of await readdir(this.directory)) {
      if (entry !== ".git") await rm(path.join(this.directory, entry), { recursive: true, force: true });
    }
    await this.copySource();
    return collectGitSummary(this.directory, before, dependencies, true);
  }

  dispose() { return rm(this.directory, { recursive: true, force: true }); }

  private copySource() {
    return cp(this.source, this.directory, {
      recursive: true, verbatimSymlinks: true,
      filter: (source) => !path.relative(this.source, source).split(path.sep).some((part) => [".git", "node_modules", ".next"].includes(part))
    });
  }
}
