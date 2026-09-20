export type DiffLineKind = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses `git diff` output into per-file line lists with old/new line numbers. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      current = { path: match?.[2] ?? raw.slice(11), oldPath: match?.[1], status: "modified", additions: 0, deletions: 0, binary: false, lines: [] };
      if (current.oldPath === current.path) delete current.oldPath;
      else current.status = "renamed";
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("new file mode")) { current.status = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { current.status = "deleted"; continue; }
    if (raw.startsWith("Binary files")) { current.binary = true; continue; }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode")) continue;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) { current.additions++; current.lines.push({ kind: "add", text: raw.slice(1), newNumber: newLine++ }); continue; }
    if (raw.startsWith("-")) { current.deletions++; current.lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldLine++ }); continue; }
    if (raw.startsWith(" ") || raw === "") {
      if (raw === "" && current.lines.length === 0) continue;
      current.lines.push({ kind: "context", text: raw.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
    }
  }
  return files;
}

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file?: true;
}

/** Builds a nested directory tree from repo-relative paths. */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const full of [...new Set(paths)].sort()) {
    const parts = full.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name: part, path, children: [] };
        if (index === parts.length - 1) child.file = true;
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}
