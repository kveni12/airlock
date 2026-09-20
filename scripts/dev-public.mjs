// Run backend + frontend + the single-origin gateway, then publish the gateway through a Cloudflare quick tunnel.
//
//   npm run dev:public                 # browse-anywhere demo (writes restricted, Docker+fixtures runs only)
//   GATEWAY_PASS=secret npm run dev:public   # whole site behind basic auth (user: periscope)
//   npm run dev:public -- --no-tunnel  # gateway only, no cloudflared
//
// Requires `cloudflared` on PATH for the tunnel (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const gatewayPort = process.env.GATEWAY_PORT ?? "8787";
const storePath = process.env.AGENTGUARD_STORE_PATH ?? path.join(root, "data", "agentguard-store.json");
const noTunnel = process.argv.includes("--no-tunnel");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
const stopAll = () => children.forEach((child) => child.kill());
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });

const start = (cmd, args, opts, name) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: opts.stdio ?? "inherit", shell: process.platform === "win32", ...opts });
    children.push(child);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`))));
  });

if (!existsSync(path.join(root, "frontend", "node_modules"))) {
  await start(npm, ["install"], { cwd: path.join(root, "frontend") }, "frontend install");
}

const baseEnv = { ...process.env, AGENTGUARD_STORE_PATH: storePath };
// Empty API URL → the frontend calls /api/* on its own origin, which the gateway routes to the backend.
const frontendEnv = { ...baseEnv, NEXT_PUBLIC_AGENTGUARD_API_URL: "" };

const tasks = [
  start(npm, ["run", "dev"], { env: baseEnv }, "backend"),
  start(npm, ["run", "dev"], { cwd: path.join(root, "frontend"), env: frontendEnv }, "frontend"),
  start(process.execPath, [path.join(root, "scripts", "public-gateway.mjs")], { env: baseEnv }, "gateway")
];

if (!noTunnel) {
  const hasCloudflared = spawnSync("cloudflared", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
  if (!hasCloudflared) {
    console.error("\ncloudflared not found on PATH — gateway is up on http://127.0.0.1:" + gatewayPort + " but no public URL. Install cloudflared or pass --no-tunnel.\n");
  } else {
    const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${gatewayPort}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(tunnel);
    const onLine = (chunk) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) console.log(`\nPublic URL → ${match[0]}\n  ${process.env.GATEWAY_PASS ? `basic auth user "${process.env.GATEWAY_USER ?? "periscope"}"` : "open to anyone with the link; runs limited to Docker + fixtures/*"}\n  temporary: dies when this process stops\n`);
    };
    tunnel.stdout.on("data", onLine);
    tunnel.stderr.on("data", onLine);
    tasks.push(new Promise((_, reject) => tunnel.on("exit", (code) => reject(new Error(`cloudflared exited with ${code}`)))));
  }
}

console.log(`\nBackend  → http://localhost:3000\nFrontend → http://localhost:3001\nGateway  → http://127.0.0.1:${gatewayPort}\n`);
await Promise.race(tasks).catch((error) => console.error(error.message)).finally(stopAll);
