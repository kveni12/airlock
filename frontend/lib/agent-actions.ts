import type { AgentEvent, PermissionSnapshot } from "./contracts.js";

export interface CommandView { command: string; workdir: string; escalation: boolean }
export interface Attempt { action: "Read" | "Write" | "Delete" | "Access"; path: string; access: string; outside: boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Decode string literals only; never evaluate the JavaScript in an exec tool request. */
function field(source: string, key: string): string[] {
  const regex = new RegExp(`(?:"${key}"|'${key}'|\\b${key})\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, "g");
  return [...source.matchAll(regex)].map((match) => {
    try { return match[1].startsWith('"') ? JSON.parse(match[1]) as string : match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\"); }
    catch { return match[1]; }
  });
}
function commandObjects(source: string): string[] {
  const objects: string[] = [];
  for (const match of source.matchAll(/(?:exec_command|run_command)\s*\(\s*\{/g)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf("{");
    let depth = 0, quote = "", escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = ""; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === "{") depth++;
      if (char === "}" && --depth === 0) { objects.push(source.slice(start, i + 1)); break; }
    }
  }
  return objects;
}
export function commandsFor(event: AgentEvent): CommandView[] {
  const args = event.metadata?.arguments;
  const object = record(args);
  if (typeof object.cmd === "string" || typeof object.command === "string") return [{ command: String(object.cmd ?? object.command), workdir: String(object.workdir ?? object.cwd ?? event.metadata?.cwd ?? "/workspace"), escalation: object.sandbox_permissions === "require_escalated" }];
  if (typeof args !== "string") return [];
  const objects = commandObjects(args);
  return (objects.length ? objects : [args]).flatMap((source) => [...field(source, "cmd"), ...field(source, "command")].map((command) => ({ command, workdir: field(source, "workdir")[0] ?? "/workspace", escalation: field(source, "sandbox_permissions").includes("require_escalated") })));
}
function normalize(path: string, cwd = "/workspace") {
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
  return "/" + parts.join("/");
}
function accessAt(path: string, permissions: PermissionSnapshot): string {
  if (path !== "/workspace" && !path.startsWith("/workspace/")) return "Outside project";
  let access = permissions.filesystem?.length ? "read" : "read_write", specificity = -1;
  for (const rule of permissions.filesystem ?? []) {
    const folder = normalize(rule.path).replace(/\/$/, "");
    if ((path === folder || path.startsWith(folder + "/")) && folder.length >= specificity) { access = rule.access; specificity = folder.length; }
  }
  return access === "read_write" ? "Can edit" : access === "read" ? "Read only" : "No access";
}
export function attemptsFor(event: AgentEvent, permissions: PermissionSnapshot): Attempt[] {
  const attempts: Attempt[] = [];
  const add = (action: Attempt["action"], raw: string, cwd?: string) => {
    if (!raw || raw.startsWith("-") || /[$*`]/.test(raw) || raw.includes("://")) return;
    const path = normalize(raw.replace(/^['"]|['"]$/g, ""), cwd);
    if (!attempts.some((a) => a.action === action && a.path === path)) attempts.push({ action, path, access: accessAt(path, permissions), outside: path !== "/workspace" && !path.startsWith("/workspace/") });
  };
  const input = record(event.metadata?.arguments);
  const tool = String(event.metadata?.tool ?? "");
  const filename = input.file_path ?? input.notebook_path;
  if (typeof filename === "string" && ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) add(tool === "Read" ? "Read" : "Write", filename, String(event.metadata?.cwd ?? "/workspace"));
  for (const { command, workdir } of commandsFor(event)) {
    // Recognize common literal shell operations; dynamic scripts remain visible as code.
    for (const line of command.split(/\n|&&|\|\||;/)) {
      const tokens = line.trim().match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
      const exe = tokens[0]?.split("/").pop();
      if (["cat", "head", "tail", "ls", "stat", "file"].includes(exe ?? "")) {
        for (const token of tokens.slice(1).filter((t) => !t.startsWith("-") && !/^\d+$/.test(t))) add("Read", token, workdir);
      }
      if (["touch", "mkdir", "rm", "rmdir"].includes(exe ?? "")) for (const token of tokens.slice(1)) add(exe === "rm" || exe === "rmdir" ? "Delete" : "Write", token, workdir);
      if (exe === "sed" && tokens.length > 2) add(tokens.some((t) => /^-i/.test(t)) ? "Write" : "Read", tokens[tokens.length - 1], workdir);
      if (["rg", "grep"].includes(exe ?? "") && tokens.length > 2 && /[./]/.test(tokens[tokens.length - 1])) add("Read", tokens[tokens.length - 1], workdir);
      if (exe === "cd" && tokens[1]) add("Access", tokens[1], workdir);
      for (const match of line.matchAll(/(?:^|\s)(?:\d*)>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) add("Write", match[1], workdir);
    }
  }
  const raw = typeof event.metadata?.arguments === "string" ? event.metadata.arguments : "";
  for (const match of raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[0].includes("Delete") ? "Delete" : "Write", match[1]);
  return attempts;
}
export function reportedChangedFiles(events: AgentEvent[]): Set<string> {
  return new Set(events.filter((event) => event.category === "agent" && event.action === "tool_result" && event.metadata?.outcome === "succeeded").flatMap((event) => Array.isArray(event.metadata?.changedFiles) ? event.metadata.changedFiles.filter((f): f is string => typeof f === "string").map((f) => normalize(f)).filter((f) => f.startsWith("/workspace/")).map((f) => f.slice(11)) : []));
}
