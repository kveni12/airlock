import { spawn, execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { claudeSession, claudeSettings } from "./claude-session.mjs";
import { codexSession } from "./codex-session.mjs";
import { codexAuthCache } from "./codex-auth-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "fixtures/permissions-demo-repo");
const args = process.argv.slice(2);
const local = args[0]?.startsWith("--local-") ?? false;
const mode = local ? args[0].replace("--local-", "--") : args[0] ?? "--help";
if (mode === "--claude" && !local) throw new Error("Use periscope claude to launch a supervised local Claude Code session.");
const modes = ["--seed", "--probe", "--shell", "--codex", "--claude", "--help"];
if (!modes.includes(mode) || args.length > 2) throw new Error("Usage: npm run demo:permissions -- --seed|--probe|--shell|--codex|--claude [project-id]");
if (mode === "--help") {
  console.log("Usage: npm run demo:permissions -- --seed|--probe|--shell|--codex|--claude [project-id]\nSee docs/permissions-demo.md. The backend must be running locally.");
  process.exit(0);
}
const base = new URL(process.env.PERISCOPE_API ?? process.env.PERISCOPE_DEMO_API ?? "http://127.0.0.1:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("This helper only attaches to a local backend and local Docker daemon.");
const cookieFile = process.env.PERISCOPE_COOKIE_FILE ?? process.env.PERISCOPE_DEMO_COOKIE_FILE;
const savedSessions = await readFile(path.join(os.homedir(), ".config/periscope/session.json"), "utf8").then(JSON.parse).catch(() => ({}));
const cookie = cookieFile
  ? (await readFile(cookieFile, "utf8")).trim()
  : savedSessions[base.origin];
const ui = (process.env.PERISCOPE_UI ?? "http://localhost:3001").replace(/\/$/, "");
const timeoutMinutes = Number(process.env.PERISCOPE_SESSION_TIMEOUT_MINUTES ?? 30);
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("Session timeout must be a positive number of minutes");
async function api(route, body) {
  const response = await fetch(new URL(route, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route}: ${value.error ?? response.status}. See docs/permissions-demo.md for local login/setup.`);
  return value;
}
const projects = await api("/api/projects");
let project = args[1] ? projects.find((p) => p.id === args[1]) : projects.find((p) => p.repoPath === fixture);
if (local && !args[1]) {
  const cwd = await realpath(process.cwd());
  const candidates = await Promise.all(projects.map(async (p) => ({ project: p, root: await realpath(p.repoPath).catch(() => "") })));
  const matches = candidates.filter((p) => p.root && (cwd === p.root || cwd.startsWith(p.root + path.sep))).sort((a, b) => b.root.length - a.root.length);
  if (matches.length > 1 && matches[0].root === matches[1].root) throw new Error("Multiple saved projects match this folder; pass the project ID explicitly.");
  project = matches[0]?.project;
}
if (mode === "--seed") {
  project ??= await api("/api/projects", {
    name: "Interactive permissions demo", repoPath: fixture, runtime: "docker", agentKind: "codex",
    scope: {
      folders: [{ path: "/workspace", access: "read" }, { path: "/workspace/src", access: "read_write" }, { path: "/workspace/tests", access: "read_write" }],
      hosts: ["api.openai.com", "auth.openai.com", "chatgpt.com"], secrets: ["PERISCOPE_DEMO_GRANTED"], mcpServers: [], tools: ["shell", "filesystem"]
    },
    notes: "Disposable fixture. Configure permissions here, then use npm run demo:permissions -- --probe, --shell, or --codex."
  });
  console.log(`Project: ${project.id}\nOpen http://localhost:3001/projects/${project.id} to edit its permissions. Existing settings were preserved.`);
  process.exit(0);
}
if (!project) throw new Error(local ? "Save this folder as a project in Periscope and configure its permissions first, or pass a saved project ID." : "Project not found. Run --seed first, or supply a saved project ID.");
if (project.runtime !== "docker") throw new Error("This demo requires Docker; Lima/process cannot enforce the same per-folder writes.");
if (mode !== "--probe" && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Run --shell/--codex/--claude from your own terminal; an interactive TTY is required.");
if (mode === "--probe" && project.repoPath !== fixture) throw new Error("The destructive permission probes only run on the bundled disposable fixture.");
const agentName = mode === "--claude" ? "Claude Code" : "Codex";
const session = mode === "--codex" ? codexSession(process.env.PERISCOPE_CODEX_AUTH ?? "chatgpt") : mode === "--claude" ? claudeSession(process.env.PERISCOPE_CLAUDE_AUTH ?? "account") : undefined;
if (session) {
  const missing = session.requiredHosts.filter((host) => !project.scope.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)));
  if (missing.length) throw new Error(`Allow ${missing.join(", ")} in this project's Internet hosts, save, then launch again. Required for ${session.auth} login; permissions were not widened automatically.`);
}
const image = process.env.PERISCOPE_DEMO_IMAGE ?? "agentguard-runtime:latest";
execFileSync("docker", ["image", "inspect", image], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`Project: ${project.name}\nImage: ${image}\nScope: ${JSON.stringify(project.scope, null, 2)}`);
console.log(local ? `LIVE LOCAL EDITS: ${project.repoPath}\nAllowed writes change your files immediately; stopping does not undo them.` : "The probe expects the seeded scope. Changing permissions may intentionally change its results.");

// Keep the primary process alive while docker exec owns the user's terminal.
// Exiting the terminal writes an exit code; the primary process then ends and
// RuntimeManager collects the diff and removes this run's container/network.
const observer = local && mode === "--codex" ? await readFile(path.join(root, "runtime/codex-observer.py"), "utf8") : undefined;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const claudeFiles = mode === "--claude" ? [
  ["/tmp/periscope_observer.py", await readFile(path.join(root, "runtime/codex-observer.py"), "utf8")],
  ["/tmp/periscope-claude-hook.py", await readFile(path.join(root, "runtime/claude-hook.py"), "utf8")],
  ["/tmp/periscope-claude-settings.json", JSON.stringify(claudeSettings())]
] : [];
const holdingCommand = local ? [
  ...claudeFiles.map(([file, content]) => `printf '%s' ${shellQuote(content)} > ${shellQuote(file)}`),
  "touch /tmp/periscope-terminal.log",
  ...(observer ? [`python3 -u -c ${shellQuote(observer)} >> /tmp/periscope-terminal.log 2>/dev/null & observer=$!`] : []),
  "tail -n +1 -f --sleep-interval=.1 /tmp/periscope-terminal.log & reader=$!",
  "date +%s > /tmp/periscope-heartbeat",
  "while [ ! -f /tmp/periscope-demo-exit ]; do now=$(date +%s); last=$(cat /tmp/periscope-heartbeat); if [ $((now-last)) -gt 30 ]; then echo 'Terminal disconnected; stopping session'; kill $reader; exit 124; fi; sleep 1; done",
  "code=$(cat /tmp/periscope-demo-exit); if [ -n \"${observer:-}\" ]; then wait $observer; fi; sleep .3; kill $reader; wait $reader 2>/dev/null; exit \"$code\""
].join("\n") : "while [ ! -f /tmp/periscope-demo-exit ]; do sleep 1; done; code=$(cat /tmp/periscope-demo-exit); exit \"$code\"";
const command = mode === "--probe"
  ? ["bash", "-c", await readFile(path.join(root, "scripts/permissions-probe.sh"), "utf8")]
  : ["bash", "-c", holdingCommand];
const scope = project.scope;
const taskId = `${local ? "local-session" : "permissions-demo"}-${Date.now()}`;
const humanRequest = local && project.humanIntent ? await api("/api/requests", { taskId, rawPrompt: project.humanIntent, analysisMode: "rules" }) : undefined;
const created = await api("/api/runs", {
  requestId: humanRequest?.request.id,
  taskId, agentId: mode === "--claude" ? "claude-interactive" : mode === "--codex" ? "codex-interactive" : local ? "shell-interactive" : "permissions-probe",
  projectId: project.id, repo: { path: project.repoPath, ...(!local && project.branch ? { branch: project.branch } : {}) }, command,
  permissions: { filesystem: scope.folders, network: scope.hosts, secrets: ["chatgpt", "account"].includes(session?.auth) ? scope.secrets.filter((name) => !["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name)) : scope.secrets, mcpServers: scope.mcpServers, tools: scope.tools },
  expectedFiles: local ? [] : ["src/**", "tests/**"], runtime: { provider: "docker", image }, timeoutMs: timeoutMinutes * 60 * 1000, cleanupWorkspace: !local, workspaceMode: local ? "local" : "copy"
});
const route = `/api/runs/${created.runId}`;
console.log(`Run: ${created.runId}\nWatch: ${ui}/workbench/${created.runId}\nProject & permissions: ${ui}/projects/${project.id}`);
const terminal = (run) => ["completed", "failed", "stopped"].includes(run.status);
let finished = false;
let heartbeat;
let authCache, authContainer, authSaveTimer;
try {
  let run;
  const deadline = Date.now() + 120_000;
  do {
    run = await api(route);
    if (terminal(run) || run.status === "running") break;
    if (Date.now() > deadline) throw new Error("Sandbox did not become ready within two minutes.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (true);
  if (mode !== "--probe" && !terminal(run)) {
    // RuntimeManager publishes the container ID before Docker.start completes.
    // Check actual readiness, and refuse a mismatched local daemon/container.
    const attachDeadline = Date.now() + 15_000;
    while (true) {
      const state = execFileSync("docker", ["inspect", "--format", '{{.State.Running}} {{index .Config.Labels "agentguard.run"}}', run.containerId], { encoding: "utf8" }).trim().split(" ");
      if (state[1] !== run.id) throw new Error("Container is not labelled for this Periscope run.");
      if (state[0] === "true") break;
      if (Date.now() > attachDeadline) throw new Error("Container did not start in time for terminal attach.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log(local ? (session ? `${agentName} attaches directly to your terminal. Periscope records messages and tool actions from ${agentName}, plus observed files and network activity. Full tool output, login, and private reasoning are not recorded.` : "Periscope is observing files, proxy traffic, and shell output. Edits are immediate; individual tool calls are not independently traced.") : "Native-terminal prototype: file/proxy/Git evidence is collected; docker exec terminal output and tool calls are not recorded by Periscope.");
    if (local) heartbeat = setInterval(() => {
      try { execFileSync("docker", ["exec", run.containerId, "sh", "-c", 'date +%s > /tmp/periscope-heartbeat'], { stdio: "ignore", timeout: 3000 }); } catch { /* Backend Stop or timeout also ends docker exec. */ }
    }, 5000);
    const attach = (command) => new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-it", "-e", `TERM=${process.env.TERM ?? "xterm-256color"}`, "-w", "/workspace", run.containerId, ...command], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (session) {
      if (session.auth === "chatgpt" && process.env.PERISCOPE_CODEX_PERSIST_LOGIN !== "0") {
        authCache = codexAuthCache();
        authContainer = run.containerId;
        if (authCache.restore(authContainer)) console.log("Reusing your saved Periscope Codex login.");
      }
      console.log(session.auth === "account" ? "Sign in with your Claude subscription using the URL below. If the container cannot open a browser, open the URL on your computer and follow the terminal instructions. Login is not recorded." : session.auth === "chatgpt" ? "Checking Codex login. If needed, sign in with the link and code below. Login output is not recorded." : "Signing in with the explicitly selected API-key mode.");
      const loginExit = await attach(["bash", "-c", session.login]);
      if (loginExit !== 0) throw new Error(`${agentName} login exited with ${loginExit}. Check the terminal instructions and the project network events.`);
      if (authCache) {
        if (!authCache.save(authContainer)) console.warn("Could not save Codex login; you may need to sign in next time.");
        authSaveTimer = setInterval(() => authCache.save(authContainer), 10_000);
      }
    }
    // The project description configures/audits permissions; the user supplies
    // their actual task interactively after the agent opens.
    const launch = session ? session.launch : "exec bash --noprofile --norc";
    // Codex owns its TUI and must receive Docker's terminal directly. Nesting a
    // Python PTY loses dimensions/resize and can leave Codex rendering at 0x0.
    const recorder = local && !session ? await readFile(path.join(root, "runtime/terminal-recorder.py"), "utf8") : undefined;
    const terminalCommand = recorder ? ["python3", "-c", recorder, "bash", "-c", launch] : ["bash", "-c", launch];
    const exitCode = await attach(terminalCommand);
    clearInterval(authSaveTimer);
    if (authCache) authCache.save(authContainer);
    clearInterval(heartbeat);
    run = await api(route);
    if (!terminal(run) && run.status !== "stopping") execFileSync("docker", ["exec", run.containerId, "sh", "-c", 'printf "%s" "$1" > /tmp/periscope-demo-exit', "sh", String(exitCode)]);
  }
  const endDeadline = Date.now() + (mode === "--probe" ? 120_000 : 30_000);
  while (!terminal(run)) {
    if (Date.now() > endDeadline) throw new Error("Run did not finish; check backend logs.");
    await new Promise((resolve) => setTimeout(resolve, 500));
    run = await api(route);
  }
  finished = true;
  const result = await api(`${route}/events`);
  for (const event of result.events ?? []) {
    if (!local && event.category === "process" && event.action === "output") console.log(event.metadata?.line ?? event.metadata?.text ?? JSON.stringify(event.metadata));
  }
  console.log(`Status: ${run.status}; exit: ${run.exitCode}\nChanged files: ${(run.gitSummary?.files ?? []).join(", ") || "none"}`);
  if (run.failureReason) console.error(run.failureReason);
  process.exitCode = run.status === "completed" && run.exitCode === 0 ? 0 : 1;
} finally {
  clearInterval(authSaveTimer);
  if (authCache) { authCache.save(authContainer); authCache.release(); }
  clearInterval(heartbeat);
  if (!finished) await api(`${route}/stop`, {}).catch((error) => console.error(`Could not stop run: ${error.message}`));
}
