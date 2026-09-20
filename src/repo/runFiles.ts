import type { PermissionSnapshot, RunRecord } from "../types.js";
import { relativeGrantPath } from "../runtime/sandboxProvider.js";
import { listRepoDirectory } from "./repoTree.js";

export function accessForFile(file: string, permissions: PermissionSnapshot, readOnly = false) {
  const rules = permissions.filesystem ?? [];
  let access: "none" | "read" | "read_write" = rules.length ? "read" : "read_write";
  let specificity = -1;
  for (const rule of rules) {
    const relative = relativeGrantPath(rule.path);
    if ((!relative || file === relative || file.startsWith(relative + "/")) && relative.length >= specificity) {
      access = rule.access;
      specificity = relative.length;
    }
  }
  return readOnly && access === "read_write" ? "read" : access;
}

export async function listRunDirectory(run: RunRecord, permissions: PermissionSnapshot, dir: string) {
  const root = run.workspacePath ?? (run.workspaceMode === "local" ? run.repoPath : undefined);
  if (!root) throw new Error("The workspace is not available yet");
  const listing = await listRepoDirectory(root, dir);
  return { dir: listing.dir, entries: listing.entries.map((entry) => ({ ...entry, access: accessForFile(entry.path, permissions, run.workspaceAccess === "read_only") })) };
}
