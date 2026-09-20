import { localAgent } from "../../shared/local-agents.mjs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectScope, RequestAnalysis } from "../types.js";

/** Suggestions are deliberately narrow: only existing explicitly named directories get writes. */
export async function suggestScope(repoPath: string, analysis: RequestAnalysis, agentKind = "codex") {
  const root = await realpath(repoPath);
  const directories: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 3 || directories.length >= 400) return;
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      directories.push(rel);
      await walk(rel, depth + 1);
      if (directories.length >= 400) break;
    }
  }
  await walk("", 0);
  const mentions = (text: string, dir: string) => new RegExp(`(^|[^a-zA-Z0-9_/-])(?:/workspace/|\\./)?${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-zA-Z0-9_/-]|/(?:\\*|$))`, "i").test(text);
  const blocked = directories.filter((dir) => analysis.explicitConstraints.some((c) => mentions(c.text, dir)));
  const warnings = [...analysis.ambiguities];
  const folders: ProjectScope["folders"] = [{ path: "/workspace", access: "read" }];
  for (const dir of directories) {
    const candidates = analysis.objectives.filter((o) => mentions(o.text, dir));
    const write = candidates.some((o) => /\b(edit|fix|update|change|write|create|implement|refactor|add|remove|delete|modify|build)\b/i.test(o.text) && !/\b(read.only|only read|inspect|look|review|do not|don't|never|without|avoid)\b/i.test(o.text));
    // Do not widen a parent around a restricted child.
    if (write && !blocked.some((b) => b === dir || b.startsWith(dir + "/") || dir.startsWith(b + "/"))) folders.push({ path: `/workspace/${dir}`, access: "read_write" });
  }
  for (const dir of blocked) {
    if (analysis.explicitConstraints.some((c) => mentions(c.text, dir) && /\b(read|access|open|see)\b/i.test(c.text))) folders.push({ path: `/workspace/${dir}`, access: "none" });
  }
  if (!folders.some((f) => f.access === "read_write")) warnings.push("No explicit writable folder was identified. Choose folders below if edits are needed.");
  const hosts = new Set(localAgent(agentKind).hosts);
  for (const objective of analysis.objectives) {
    for (const match of objective.text.matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:\/[^\s]*)?/gi)) {
      const host = match[1].toLowerCase();
      if (!analysis.explicitConstraints.some((c) => c.text.toLowerCase().includes(host))) hosts.add(host);
    }
  }
  if (analysis.explicitConstraints.some((c) => /\b(internet|network|external|openai|chatgpt)\b/i.test(c.text))) warnings.push(`${localAgent(agentKind).name} account login still needs ${localAgent(agentKind).hosts.join(", ")}. Hosted services can perform actions outside the direct network allowlist.`);
  warnings.push("These are regex suggestions, not a complete interpretation. Check every permission before saving. Secrets are never granted from prose.");
  return { scope: { folders, hosts: [...hosts], secrets: [], mcpServers: [], tools: ["filesystem", "shell"] } satisfies ProjectScope, warnings, analysis };
}
