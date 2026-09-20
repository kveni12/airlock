#!/usr/bin/env node
// One-command local setup: checks Node + Docker, installs backend/frontend deps, builds the sandbox image.
//   npm run setup            # everything
//   npm run setup -- --no-docker   # skip the Docker image (process runtime only)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDocker = process.argv.includes("--no-docker");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const problems = [];

function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); problems.push(msg); }
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", shell: process.platform === "win32", ...opts });
}

console.log("\nPeriscope setup\n");

const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else warn(`Node ${process.versions.node} found; Periscope needs Node 22+ (https://nodejs.org or \`brew install node\`).`);

const docker = sh("docker", ["info"], { quiet: true });
const dockerReady = docker.status === 0;
if (dockerReady) ok("Docker is running");
else warn(process.platform === "darwin"
  ? "Docker is not running. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack and start it — it is the sandbox agents run in."
  : "Docker is not running. Install it (https://docs.docker.com/engine/install/) and start the daemon — it is the sandbox agents run in.");

console.log("\nInstalling dependencies…");
if (sh(npm, ["install"]).status !== 0) warn("npm install (backend) failed");
else ok("backend dependencies");
if (sh(npm, ["install"], { cwd: path.join(root, "frontend") }).status !== 0) warn("npm install (frontend) failed");
else ok("frontend dependencies");

if (!skipDocker && dockerReady) {
  console.log("\nBuilding the sandbox image (agentguard-runtime:latest, a few minutes the first time)…");
  if (sh(npm, ["run", "docker:build"]).status !== 0) warn("docker build failed — rerun `npm run docker:build` once Docker is healthy");
  else ok("sandbox image built");
} else if (!skipDocker) {
  warn("Skipped the sandbox image build because Docker is unavailable; run `npm run docker:build` later.");
}

const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((k) => process.env[k]);
console.log(`\nModel API keys in this shell: ${keys.length ? keys.join(", ") : "none"} (export them before \`npm run dev:all\`; they only reach a run when its scope grants them by name).`);
if (!existsSync(path.join(root, "data", "agentguard-store.json"))) console.log("The demo data store will be seeded on first start (AGENTGUARD_SKIP_SEED=1 to skip).");

console.log(problems.length ? `\nSetup finished with ${problems.length} thing(s) to fix:\n${problems.map((p) => `  - ${p}`).join("\n")}` : "\nAll set.");
console.log(`\nNext:\n  npm run dev:all       # backend :3000 + UI http://localhost:3001\n  npm run demo:projects # optional sample projects\nThen Projects → New project → "Open folder…" to pick any repo on this machine.\n`);
process.exit(problems.some((p) => p.startsWith("npm install")) ? 1 : 0);
