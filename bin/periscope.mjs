#!/usr/bin/env node
// Periscope CLI: run an agent's *own* interactive CLI (codex, claude, ...) inside the hardened Docker
// sandbox scoped by the Project saved for the current folder. Codex/Claude/shell edit locally; other commands use copies.
//
//   periscope codex [codex args…]        # from inside a repo that has a Project
//   periscope claude
//   periscope run -- <command…>          # any command, same sandbox
//   periscope login                      # store a session for a backend with login enabled
//
// Flags: --repo <path> (default: cwd)  --project <name|id>  --api <url> (or PERISCOPE_API, default http://localhost:3000)
//        --ui <url> (default http://localhost:3001)  --timeout <minutes> (default 480)
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const AGENTS = { codex: "codex", claude: "claude_code", opencode: "opencode", cursor: "cursor" };
const SESSION_FILE = path.join(os.homedir(), ".config", "periscope", "session.json");

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
let passthrough = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--") { passthrough = argv.slice(i + 1); break; }
  if (arg.startsWith("--")) { flags[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1"; continue; }
  positional.push(arg);
}
const [command, ...rest] = positional;
const API = (flags.api ?? process.env.PERISCOPE_API ?? "http://localhost:3000").replace(/\/$/, "");
const UI = (flags.ui ?? process.env.PERISCOPE_UI ?? "http://localhost:3001").replace(/\/$/, "");

function fail(message) { console.error(`periscope: ${message}`); process.exit(1); }

async function loadCookie() {
  try { return JSON.parse(await readFile(SESSION_FILE, "utf8"))[API] ?? null; } catch { return null; }
}

async function api(method, route, body, { allowStatus = [], soft = false } = {}) {
  const bail = (message) => { if (soft) throw new Error(message); fail(message); };
  const cookie = await loadCookie();
  let res;
  try {
    res = await fetch(`${API}${route}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    bail(`backend not reachable at ${API} — start it with \`npm run dev:all\` (or pass --api).`);
  }
  if (res.status === 401) bail("not signed in — run `periscope login` (or start the backend with PERISCOPE_AUTH_DISABLED=1).");
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !allowStatus.includes(res.status)) bail(`${method} ${route} → ${res.status}: ${data?.error ?? text}`);
  return { status: res.status, data, res };
}

async function login() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question(`Email for ${API}: `)).trim();
  const password = await rl.question("Password: ");
  rl.close();
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password })
  }).catch(() => fail(`backend not reachable at ${API}`));
  if (!res.ok) fail(`login failed (${res.status}): ${(await res.json().catch(() => ({}))).error ?? ""}`);
  const cookie = res.headers.getSetCookie?.().map((c) => c.split(";")[0]).find((c) => c.startsWith("periscope_session="));
  if (!cookie) fail("backend did not return a session cookie");
  await mkdir(path.dirname(SESSION_FILE), { recursive: true });
  let all = {};
  try { all = JSON.parse(await readFile(SESSION_FILE, "utf8")); } catch { /* first login */ }
  all[API] = cookie;
  await writeFile(SESSION_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  console.log(`Signed in as ${email}; session saved to ${SESSION_FILE}`);
}

async function findProject(repoPath) {
  const { data: projects } = await api("GET", "/api/projects");
  if (flags.project) {
    const match = projects.find((p) => p.id === flags.project || p.name.toLowerCase() === flags.project.toLowerCase());
    if (!match) fail(`no project named "${flags.project}" (have: ${projects.map((p) => p.name).join(", ") || "none"})`);
    return match;
  }
  const real = await realpath(repoPath).catch(() => repoPath);
  const matches = [];
  for (const p of projects) {
    const candidate = await realpath(path.resolve(p.repoPath)).catch(() => path.resolve(p.repoPath));
    if (candidate === real) matches.push(p);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`several projects use ${real}: ${matches.map((p) => p.name).join(", ")} — pick one with --project`);
  fail(`no Project is saved for ${real}.\nCreate one at ${UI}/projects/new ("Open folder…" → this folder) to define what the agent may see, change and reach — Periscope refuses to start an agent without a saved scope.`);
}

function describeScope(project) {
  const folders = project.scope.folders ?? [];
  const rw = folders.filter((f) => f.access === "read_write").map((f) => f.path);
  const ro = folders.filter((f) => f.access === "read").map((f) => f.path);
  const lines = [
    `Project   ${project.name}`,
    `Sandbox   docker · repo copy mounted read-only`,
    `Writable  ${rw.length ? rw.join(", ") : "nothing"}`,
    ro.length ? `Readable  ${ro.join(", ")}` : null,
    `Network   ${project.scope.hosts?.length ? project.scope.hosts.join(", ") : "none (all egress denied)"}`,
    `Secrets   ${project.scope.secrets?.length ? project.scope.secrets.join(", ") : "none"}`,
    project.scope.mcpServers?.length ? `MCP       ${project.scope.mcpServers.join(", ")}` : null
  ];
  return lines.filter(Boolean).join("\n");
}

async function startRun(repoPath, agentKind, extraArgs, explicitCommand) {
  const project = await findProject(repoPath);
  const missingSecrets = (project.scope.secrets ?? []).filter((name) => !process.env[name]);
  console.error(describeScope(project));
  if (missingSecrets.length) console.error(`Note      ${missingSecrets.join(", ")} not exported in the backend's shell — the agent will not receive ${missingSecrets.length > 1 ? "them" : "it"}.`);
  console.error("");
  const label = agentKind ?? "command";
  const body = {
    taskId: `cli-${label}-${Date.now().toString(36)}`,
    agentId: `${label}-cli`,
    agent: agentKind ? { kind: agentKind, executionMode: "sandbox_cli", args: extraArgs.length ? extraArgs : undefined } : undefined,
    command: explicitCommand,
    repo: { path: project.repoPath, branch: project.branch },
    permissions: {
      filesystem: project.scope.folders,
      network: project.scope.hosts,
      secrets: project.scope.secrets,
      mcpServers: project.scope.mcpServers,
      tools: project.scope.tools
    },
    runtime: { provider: "docker" },
    interactive: true,
    purpose: "builder",
    projectId: project.id,
    timeoutMs: Number(flags.timeout ?? 480) * 60 * 1000,
    cleanupWorkspace: false
  };
  const { data } = await api("POST", "/api/runs", body);
  const runId = data.runId;
  let run;
  for (let i = 0; i < 600; i++) {
    run = (await api("GET", `/api/runs/${runId}`)).data;
    if (run.sandboxName || ["failed", "completed", "stopped"].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!run?.sandboxName) fail(`run ${runId} did not start: ${run?.failureReason ?? run?.status}`);
  console.error(`Run ${runId} · ${UI}/workbench/${runId}\nAttaching to the sandbox; the run ends when you exit the CLI.\n`);
  const attach = spawn("docker", ["attach", run.sandboxName], { stdio: "inherit" });
  // Ctrl-C belongs to the CLI inside the sandbox (docker attach forwards it); only a hangup/terminate
  // of this wrapper stops the run so nothing keeps running unattended.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const stopOnSignal = (signal) => {
    console.error(`\nperiscope: ${signal} received, stopping run ${runId}…`);
    api("POST", `/api/runs/${runId}/stop`, {}, { soft: true }).catch(() => {}).finally(() => attach.kill("SIGKILL"));
  };
  process.on("SIGTERM", () => stopOnSignal("SIGTERM"));
  process.on("SIGHUP", () => stopOnSignal("SIGHUP"));
  await new Promise((resolve) => attach.on("exit", resolve));
  process.off("SIGINT", ignore);

  try {
    for (let i = 0; i < 120; i++) {
      run = (await api("GET", `/api/runs/${runId}`, undefined, { soft: true })).data;
      if (!["starting", "running", "paused"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (error) {
    fail(`lost the backend after the session ended (${error instanceof Error ? error.message : error}).\nThe sandbox ${run.sandboxName} may still be running: \`docker stop ${run.sandboxName}\`; the run is ${UI}/runs/${runId} once the backend is back.`);
  }
  if (["starting", "running", "paused"].includes(run.status)) {
    console.error(`\nRun ${runId} is still ${run.status} (detached without exiting the CLI?). Re-attach with \`docker attach ${run.sandboxName}\` or stop it from ${UI}/runs/${runId}.`);
    process.exit(0);
  }
  const git = run.gitSummary;
  console.error(`\nRun ${run.status}${run.exitCode != null ? ` (exit ${run.exitCode})` : ""} · ${git ? `${git.filesChanged} file(s) changed` : "no diff captured"}`);
  if (git?.files?.length) for (const file of git.files) console.error(`  ${file}`);
  console.error(`Review, findings and diff: ${UI}/runs/${runId}\nYour folder is untouched; apply the change from the workbench (or the run's PR) once reviewed.`);
  process.exit(run.status === "completed" ? 0 : 1);
}

async function main() {
  if (!command || flags.help) {
    console.log(`usage: periscope <codex|shell|claude|opencode|cursor> [agent args…]\n       periscope run -- <command…>\n       periscope login\nSee the header of ${new URL(import.meta.url).pathname} for flags.`);
    return;
  }
  if (command === "login") return login();
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) fail("docker CLI is required to attach to the sandbox (Docker Desktop / OrbStack running?).");
  const repoPath = path.resolve(flags.repo ?? process.cwd());
  if (command === "run") {
    if (!passthrough.length) fail("usage: periscope run -- <command…>");
    return startRun(repoPath, undefined, [], passthrough);
  }
  if (command === "codex" || command === "claude" || command === "shell") {
    const unknown = Object.keys(flags).filter((key) => !["repo", "project", "api", "ui", "timeout"].includes(key));
    if (unknown.length) fail(`Unsupported local-session flags: ${unknown.map((key) => `--${key}`).join(", ")}`);
    if (passthrough.length || rest.length > 1) fail("Local sessions accept a project ID or --project <name|id>; agent arguments are not supported yet.");
    if (rest[0]) flags.project ??= rest[0];
    process.env.PERISCOPE_API = API;
    process.env.PERISCOPE_UI = UI;
    if (flags.timeout) process.env.PERISCOPE_SESSION_TIMEOUT_MINUTES = flags.timeout;
    process.chdir(repoPath);
    const project = flags.project ? await findProject(repoPath) : undefined;
    process.argv = [process.argv[0], process.argv[1], `--local-${command}`, ...(project ? [project.id] : [])];
    return import("../scripts/permissions-demo.mjs");
  }
  const kind = AGENTS[command];
  if (!kind) fail(`unknown agent "${command}" (use ${Object.keys(AGENTS).join(", ")}, or \`run -- <command>\`)`);
  return startRun(repoPath, kind, [...rest, ...passthrough]);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
