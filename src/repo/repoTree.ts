import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface RepoTreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface RepoTreeListing {
  repoPath: string;
  dir: string;
  entries: RepoTreeEntry[];
}

const SKIPPED = new Set([".git", "node_modules"]);

/** Lists one level of a local repository so the UI can offer folder-level access grants before a run exists. Never leaves the repo root. */
export async function listRepoDirectory(repoPath: string, dir = ""): Promise<RepoTreeListing> {
  const root = await realpath(repoPath);
  const target = path.resolve(root, dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("dir must stay inside the repository");
  }
  const resolved = await realpath(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Directory symlink leaves the repository");
  const dirents = await readdir(resolved, { withFileTypes: true });
  const rel = path.relative(root, target).split(path.sep).filter(Boolean).join("/");
  const entries = dirents
    .filter((d) => !SKIPPED.has(d.name) && (d.isDirectory() || d.isFile()))
    .map<RepoTreeEntry>((d) => ({
      name: d.name,
      path: rel ? `${rel}/${d.name}` : d.name,
      kind: d.isDirectory() ? "dir" : "file"
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { repoPath: root, dir: rel, entries };
}
