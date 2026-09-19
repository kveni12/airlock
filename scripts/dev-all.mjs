// Seed the local store with the deterministic intent demo (once), then run backend + frontend together.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const storePath = process.env.AGENTGUARD_STORE_PATH ?? path.join(root, "data", "agentguard-store.json");
const env = { ...process.env, AGENTGUARD_STORE_PATH: storePath };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (args, cwd, name) =>
  new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`))));
    children.push(child);
  });
const children = [];
const stopAll = () => children.forEach((child) => child.kill());
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });

if (!existsSync(path.join(root, "frontend", "node_modules"))) {
  await run(["install"], path.join(root, "frontend"), "frontend install");
}
if (!existsSync(storePath) && !process.env.AGENTGUARD_SKIP_SEED) {
  console.log(`Seeding ${storePath} with demo:intent ...`);
  await run(["run", "demo:intent"], root, "demo:intent");
}

console.log("\nBackend  → http://localhost:3000\nFrontend → http://localhost:3001\n");
await Promise.race([
  run(["run", "dev"], root, "backend"),
  run(["run", "dev"], path.join(root, "frontend"), "frontend")
]).catch((error) => { console.error(error.message); }).finally(stopAll);
