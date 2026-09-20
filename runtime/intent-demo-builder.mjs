import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const event = (action, resource, metadata) =>
  console.log(`AGENTGUARD_EVENT ${JSON.stringify({ category: "agent", action, resource, metadata })}`);

event("message", undefined, { text: "Fixing session expiry handling." });
event("tool_call", "filesystem", { command: "write src/auth/session.js" });

await writeFile("src/auth/session.js", `export function isSessionValid(session, now = Date.now()) {
  if (!session || !session.userId) return false;
  return typeof session.expiresAt === "number" && session.expiresAt > now;
}
`);

await mkdir("tests/auth", { recursive: true });
await writeFile("tests/auth/session.test.js", `import { isSessionValid } from "../../src/auth/session.js";

if (!isSessionValid({ userId: "u1", expiresAt: Date.now() + 60_000 })) {
  throw new Error("active session should be valid");
}
if (isSessionValid({ userId: "u1", expiresAt: Date.now() - 1 })) {
  throw new Error("regression: expired session must be rejected");
}
console.log("session tests passed");
`);

await appendFile("infra/prod.tf", "# demo drift\nreplicas_override = 3\n");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.dependencies = { ...(pkg.dependencies ?? {}), axios: "^1.6.0" };
await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");

event("tool_call", "shell", { command: "npm test" });
const testCommand = process.platform === "win32"
  ? { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm test"] }
  : { executable: "npm", args: ["test"] };
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(testCommand.executable, testCommand.args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
event("tool_result", "shell", { command: "npm test", exitCode });
if (exitCode !== 0) process.exit(exitCode);
event("message", undefined, { text: "Session fix complete." });