import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { compareUrlFor, manifestToMarkdown, type RunManifest } from "../src/manifest/index.js";
import { signIn } from "./testAuth.js";
import type { AgentIntent, Review, RunPullRequest, RunRecord } from "../src/types.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "fixtures/intent-demo-repo");

const BUILDER = `#!/usr/bin/env bash
set -euo pipefail
cat > src/auth/session.js <<'JS'
export function isSessionValid(session, now = Date.now()) { return !!session && session.expiresAt > now; }
JS
echo 'AGENTGUARD_EVENT {"category":"process","action":"command_start","resource":"npm test"}'
`;

const INTENT = {
  goal: "Fix session expiry",
  interpretation: "Reject expired sessions",
  plannedActions: ["Fix isSessionValid"],
  expectedFiles: ["src/auth/session.js"],
  expectedDependencies: [],
  expectedCommands: ["npm test"],
  expectedNetwork: [],
  expectedMcpServers: [],
  expectedSecrets: [],
  expectedTools: ["filesystem"],
  constraints: ["Do not modify infrastructure"]
};

let cookie = "";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out polling");
}

describe("run manifest + pull request from approved run", () => {
  let temp: string;
  let repo: string;
  let app: FastifyInstance;
  let runId: string;

  async function api<T>(method: "GET" | "POST", url: string, body?: Record<string, unknown>): Promise<{ status: number; json: T }> {
    const response = await app.inject({ method, url, payload: body, headers: { cookie } });
    return { status: response.statusCode, json: response.json() as T };
  }

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "periscope-manifest-"));
    repo = path.join(temp, "repo");
    await cp(fixture, repo, { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "."]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base"]);
    const builder = path.join(temp, "builder.sh");
    await writeFile(builder, BUILDER);
    await chmod(builder, 0o755);

    const store = new JsonStore(path.join(temp, "store.json"));
    const auth = new AuthService(store);
    app = await createApp({ store, auth });
    await app.ready();
    cookie = await signIn(app, auth);

    const { json: { request } } = await api<{ request: { id: string } }>("POST", "/api/requests", { taskId: "manifest", rawPrompt: "Fix session expiry. Do not modify infrastructure." });
    const { json: intent } = await api<AgentIntent>("POST", "/api/intents", { taskId: "manifest", agentId: "builder", agentType: "custom", requestId: request.id, ...INTENT });
    await api("POST", `/api/intents/${intent.id}/approve`, {});
    const { json: created } = await api<{ runId: string }>("POST", "/api/runs", {
      taskId: "manifest",
      agentId: "builder",
      repo: { path: repo },
      command: [builder],
      permissions: { filesystem: [{ path: "src/auth", access: "read_write" }], tools: ["filesystem"] },
      runtime: { provider: "process" },
      intentId: intent.id,
      requestId: request.id,
      timeoutMs: 60_000
    });
    runId = created.runId;
    await poll(() => api<RunRecord>("GET", `/api/runs/${runId}`), (r) => r.json.status === "completed");
  });

  afterAll(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });

  it("composes a manifest across request → intent → permissions → behavior → result → decision", async () => {
    const { status, json: manifest } = await api<RunManifest>("GET", `/api/runs/${runId}/manifest`);
    expect(status).toBe(200);
    expect(manifest.version).toBe(1);
    expect(manifest.run.id).toBe(runId);
    expect(manifest.request?.prompt).toContain("Fix session expiry");
    expect(manifest.request?.explicitConstraints.join(" ")).toMatch(/infrastructure/i);
    expect(manifest.intent?.goal).toBe("Fix session expiry");
    expect(manifest.intent?.approval?.status).toBe("approved");
    expect(manifest.permissions.granted.filesystem).toEqual([{ path: "src/auth", access: "read_write" }]);
    expect(manifest.permissions.secretsInjected).toEqual([]);
    expect(manifest.behavior.filesChanged).toEqual(["src/auth/session.js"]);
    expect(manifest.behavior.commands).toContain("npm test");
    expect(manifest.alignment.requestToIntent).toBe("aligned");
    expect(manifest.decision.status).toBe("not_reviewed");
    expect(manifest.timeline.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest)).not.toContain("workspacePath");

    const markdown = await app.inject({ method: "GET", url: `/api/runs/${runId}/manifest?format=markdown`, headers: { cookie } });
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.body).toContain(`# Run Manifest — ${runId}`);
    expect(markdown.body).toContain("## 7. Human decision");
    expect(manifestToMarkdown(manifest)).toContain("src/auth/session.js");
  });

  it("404s for unknown runs", async () => {
    expect((await api("GET", "/api/runs/run_nope/manifest")).status).toBe(404);
    expect((await api("POST", "/api/runs/run_nope/pull-request", {})).status).toBe(404);
  });

  it("refuses to create a pull request until a human approves the review, then commits exactly the reviewed diff on a new branch", async () => {
    const unreviewed = await api<{ error: string }>("POST", `/api/runs/${runId}/pull-request`, {});
    expect(unreviewed.status).toBe(409);
    expect(unreviewed.json.error).toMatch(/not reviewed/);

    const { json: review } = await api<Review>("POST", `/api/runs/${runId}/review`, {});
    expect(review.status).toBe("needs_human");
    const pending = await api<{ error: string }>("POST", `/api/runs/${runId}/pull-request`, {});
    expect(pending.status).toBe(409);
    expect(pending.json.error).toMatch(/needs human/);

    await api("POST", `/api/reviews/${review.id}/approve`, { reason: "Looks right" });
    const before = await git(repo, ["rev-parse", "HEAD"]);
    const { status, json: pr } = await api<RunPullRequest>("POST", `/api/runs/${runId}/pull-request`, { branch: "periscope/session fix" });
    expect(status).toBe(201);
    expect(pr.branch).toBe("periscope/session-fix");
    expect(pr.pushed).toBe(false);

    // Source checkout untouched; new branch has exactly one commit with the reviewed diff + manifest.
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    expect(await git(repo, ["rev-parse", pr.branch])).toBe(pr.commit);
    expect(await git(repo, ["rev-parse", `${pr.branch}^`])).toBe(before);
    expect(await git(repo, ["diff", "--name-only", before, pr.branch])).toBe("src/auth/session.js");
    const message = await git(repo, ["log", "-1", "--format=%B", pr.branch]);
    expect(message).toContain("Periscope: Fix session expiry");
    expect(message).toContain("## 7. Human decision");
    expect(message).toContain("**approved**");
    expect(await git(repo, ["show", `${pr.branch}:src/auth/session.js`])).toContain("session.expiresAt > now");
    expect(await readFile(path.join(repo, "src/auth/session.js"), "utf8")).not.toContain("session.expiresAt > now");

    const { json: run } = await api<RunRecord>("GET", `/api/runs/${runId}`);
    expect(run.pullRequest?.branch).toBe(pr.branch);
    const { json: manifest } = await api<RunManifest>("GET", `/api/runs/${runId}/manifest`);
    expect(manifest.decision.status).toBe("approved");
    expect(manifest.run.pullRequest?.commit).toBe(pr.commit);

    const again = await api<{ error: string }>("POST", `/api/runs/${runId}/pull-request`, {});
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/already has branch/);
  });

  it("builds compare URLs for GitHub-style remotes", () => {
    expect(compareUrlFor("git@github.com:kveni12/airlock.git", "periscope/run_1")).toBe("https://github.com/kveni12/airlock/compare/periscope%2Frun_1?expand=1");
    expect(compareUrlFor("https://github.com/kveni12/airlock", "x")).toBe("https://github.com/kveni12/airlock/compare/x?expand=1");
    expect(compareUrlFor("/local/path", "x")).toBeUndefined();
  });
});
