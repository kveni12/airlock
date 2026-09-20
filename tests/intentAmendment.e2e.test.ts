import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { mergeIntent, mergePermissions } from "../src/intent/intentAmendmentService.js";
import { signIn } from "./testAuth.js";
import type { AgentEvent, AgentIntent, IntentAmendment, PermissionSnapshot, RunRecord } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "fixtures/intent-demo-repo");
const runtime = { provider: "process" as const };

/**
 * Builder that hits a limit of its plan: it asks Periscope (through the proxy control channel) for
 * permission to touch infra/prod.tf, blocks until a human decides, and only then acts on the answer.
 */
const CONTROL_BUILDER = `#!/usr/bin/env bash
set -euo pipefail
echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"Session fix done; infra change needed."}}'
cat > src/auth/session.js <<'JS'
export function isSessionValid(session, now = Date.now()) { return !!session && session.expiresAt > now; }
JS
body='{"reason":"The session TTL is configured in infra/prod.tf; the fix is incomplete without raising it.","changes":{"plannedActions":["Raise session TTL in Terraform"],"expectedFiles":["infra/prod.tf"]},"permissions":{"filesystem":[{"path":"infra","access":"read_write"}],"network":["registry.terraform.io"]}}'
created=$(curl -sS -x "$HTTP_PROXY" -H 'content-type: application/json' -d "$body" http://periscope.internal/amendments)
id=$(node -e 'const a=JSON.parse(process.argv[1]); if(!a.id) {console.error(a); process.exit(1)}; console.log(a.id)' "$created")
echo "amendment=$id"
status=pending
while [ "$status" = pending ]; do
  status=$(curl -sS -x "$HTTP_PROXY" "http://periscope.internal/amendments/$id?wait=5" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).status))')
done
echo "decision=$status"
if [ "$status" = approved ]; then
  printf '\\nsession_ttl = 3600\\n' >> infra/prod.tf
fi
echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"Done."}}'
`;

/** Builder without HTTP: reports the request on stdout, then exits (it cannot wait for the answer). */
const STDOUT_BUILDER = `#!/usr/bin/env bash
set -euo pipefail
echo 'AGENTGUARD_EVENT {"category":"agent","action":"intent_amendment","metadata":{"reason":"Need axios for retries","changes":{"expectedDependencies":["axios"]},"permissions":{"network":["registry.npmjs.org"]}}}'
sleep 1
`;

let cookie = "";

async function api<T>(app: FastifyInstance, method: "GET" | "POST", url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await app.inject({ method, url, payload: body, headers: { cookie } });
  if (response.statusCode >= 400) throw new Error(`${method} ${url} -> ${response.statusCode}: ${response.body}`);
  return response.json() as T;
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

const INTENT = {
  goal: "Fix session expiry",
  interpretation: "Reject expired sessions",
  plannedActions: ["Fix isSessionValid"],
  expectedFiles: ["src/auth/session.js"],
  expectedDependencies: [],
  expectedCommands: [],
  expectedNetwork: [],
  expectedMcpServers: [],
  expectedSecrets: [],
  expectedTools: ["filesystem"],
  constraints: ["Do not modify infrastructure"]
};

describe("intent amendments (process runtime)", () => {
  let temp: string;
  let app: FastifyInstance;
  let controlBuilder: string;
  let stdoutBuilder: string;

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "periscope-amend-"));
    controlBuilder = path.join(temp, "control-builder.sh");
    stdoutBuilder = path.join(temp, "stdout-builder.sh");
    await writeFile(controlBuilder, CONTROL_BUILDER);
    await writeFile(stdoutBuilder, STDOUT_BUILDER);
    await chmod(controlBuilder, 0o755);
    await chmod(stdoutBuilder, 0o755);
    const store = new JsonStore(path.join(temp, "store.json"));
    const auth = new AuthService(store);
    app = await createApp({ store, auth });
    await app.ready();
    cookie = await signIn(app, auth);
  });

  afterAll(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function startBuilder(taskId: string, command: string): Promise<{ runId: string; intent: AgentIntent }> {
    const intent = await api<AgentIntent>(app, "POST", "/api/intents", { taskId, agentId: "builder", agentType: "custom", ...INTENT });
    await api(app, "POST", `/api/intents/${intent.id}/approve`, {});
    const { runId } = await api<{ runId: string }>(app, "POST", "/api/runs", {
      taskId,
      agentId: "builder",
      repo: { path: fixture },
      command: [command],
      permissions: { filesystem: [{ path: "src/auth", access: "read_write" }], tools: ["filesystem"] },
      runtime,
      intentId: intent.id,
      timeoutMs: 60_000
    });
    return { runId, intent };
  }

  it("pauses the run on a control-channel request and resumes with a revised intent + merged permissions on approval", async () => {
    const { runId, intent } = await startBuilder("amend-approve", controlBuilder);

    const { amendments } = await poll(
      () => api<{ amendments: IntentAmendment[] }>(app, "GET", `/api/runs/${runId}/intent-amendments`),
      (r) => r.amendments.length === 1
    );
    const [pending] = amendments;
    expect(pending.status).toBe("pending");
    expect(pending.channel).toBe("control_channel");
    expect(pending.intentId).toBe(intent.id);
    expect(pending.changes.expectedFiles).toEqual(["infra/prod.tf"]);
    expect(pending.permissions).toEqual({ filesystem: [{ path: "infra", access: "read_write" }], network: ["registry.terraform.io"] });
    expect((await api<RunRecord>(app, "GET", `/api/runs/${runId}`)).status).toBe("paused");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await api<RunRecord>(app, "GET", `/api/runs/${runId}`)).status).toBe("paused");

    const approved = await api<IntentAmendment>(app, "POST", `/api/intent-amendments/${pending.id}/approve`, { reason: "TTL lives in Terraform" });
    expect(approved.status).toBe("approved");
    expect(approved.decision?.actor).toContain("operator@example.com");
    expect(approved.decision?.appliedLive).toEqual(["network"]);
    expect(approved.decision?.deferred).toEqual(["filesystem"]);
    expect(approved.resultingIntentId).toBeDefined();

    const run = await poll(() => api<RunRecord>(app, "GET", `/api/runs/${runId}`), (r) => ["completed", "failed"].includes(r.status));
    expect(run.status).toBe("completed");
    expect(run.intentId).toBe(approved.resultingIntentId);

    const revised = await api<AgentIntent>(app, "GET", `/api/intents/${approved.resultingIntentId}`);
    expect(revised.supersedes).toBe(intent.id);
    expect(revised.expectedFiles).toEqual(["src/auth/session.js", "infra/prod.tf"]);
    expect(revised.plannedActions).toEqual(["Fix isSessionValid", "Raise session TTL in Terraform"]);
    expect(revised.approval?.status).toBe("approved");
    const previous = await api<AgentIntent>(app, "GET", `/api/intents/${intent.id}`);
    expect(previous.supersededBy).toBe(approved.resultingIntentId);

    const permissions = await api<PermissionSnapshot>(app, "GET", `/api/runs/${runId}/permissions`);
    expect(permissions.filesystem).toEqual([
      { path: "src/auth", access: "read_write" },
      { path: "infra", access: "read_write" }
    ]);
    expect(permissions.network).toEqual(["registry.terraform.io"]);

    const { events } = await api<{ events: AgentEvent[] }>(app, "GET", `/api/runs/${runId}/events`);
    const requested = events.find((e) => e.action === "intent_amendment_requested");
    const decided = events.find((e) => e.action === "intent_amendment_approved");
    expect(requested?.correlationId).toBe(pending.id);
    expect(requested?.metadata?.runPaused).toBe(true);
    expect(decided?.correlationId).toBe(pending.id);
    expect(decided?.metadata?.previousIntentId).toBe(intent.id);
    expect(decided?.metadata?.resultingIntentId).toBe(approved.resultingIntentId);
    expect(decided?.evidenceSource).toBe("reviewer");
    const output = events.filter((e) => e.category === "process" && e.action === "output").map((e) => String(e.metadata?.text ?? ""));
    expect(output.some((line) => line.includes("decision=approved"))).toBe(true);
  });

  it("denies without changing intent or permissions and the agent stays within the original plan", async () => {
    const { runId, intent } = await startBuilder("amend-deny", controlBuilder);
    const { amendments } = await poll(
      () => api<{ amendments: IntentAmendment[] }>(app, "GET", `/api/runs/${runId}/intent-amendments`),
      (r) => r.amendments.length === 1
    );
    const denied = await api<IntentAmendment>(app, "POST", `/api/intent-amendments/${amendments[0].id}/deny`, { reason: "Infra is out of scope" });
    expect(denied.status).toBe("denied");
    expect(denied.resultingIntentId).toBeUndefined();

    const run = await poll(() => api<RunRecord>(app, "GET", `/api/runs/${runId}`), (r) => ["completed", "failed"].includes(r.status));
    expect(run.status).toBe("completed");
    expect(run.intentId).toBe(intent.id);
    const permissions = await api<PermissionSnapshot>(app, "GET", `/api/runs/${runId}/permissions`);
    expect(permissions.network).toBeUndefined();
    const { events } = await api<{ events: AgentEvent[] }>(app, "GET", `/api/runs/${runId}/events`);
    expect(events.some((e) => e.action === "intent_amendment_denied")).toBe(true);
    expect(events.some((e) => e.category === "git" && e.resource === "infra/prod.tf")).toBe(false);

    const response = await app.inject({ method: "POST", url: `/api/intent-amendments/${denied.id}/approve`, headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("records AGENTGUARD_EVENT intent_amendment lines from agent output as pending amendments", async () => {
    const { runId } = await startBuilder("amend-stdout", stdoutBuilder);
    const { amendments } = await poll(
      () => api<{ amendments: IntentAmendment[] }>(app, "GET", `/api/runs/${runId}/intent-amendments`),
      (r) => r.amendments.length === 1
    );
    expect(amendments[0].channel).toBe("agent_output");
    expect(amendments[0].changes.expectedDependencies).toEqual(["axios"]);
    expect(amendments[0].permissions.network).toEqual(["registry.npmjs.org"]);
    await poll(() => api<RunRecord>(app, "GET", `/api/runs/${runId}`), (r) => ["completed", "failed"].includes(r.status));
    const { events } = await api<{ events: AgentEvent[] }>(app, "GET", `/api/runs/${runId}/events`);
    expect(events.filter((e) => e.action === "intent_amendment").length).toBe(0);
    expect(events.some((e) => e.action === "intent_amendment_requested")).toBe(true);
  });

  it("rejects amendments with no reason or no change", async () => {
    const { runId } = await startBuilder("amend-invalid", stdoutBuilder);
    const noReason = await app.inject({ method: "POST", url: `/api/runs/${runId}/intent-amendments`, headers: { cookie }, payload: { changes: { expectedFiles: ["x"] } } });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toMatch(/reason/);
    const noChange = await app.inject({ method: "POST", url: `/api/runs/${runId}/intent-amendments`, headers: { cookie }, payload: { reason: "because" } });
    expect(noChange.statusCode).toBe(400);
    await poll(() => api<RunRecord>(app, "GET", `/api/runs/${runId}`), (r) => ["completed", "failed"].includes(r.status));
  });
});

describe("amendment merge helpers", () => {
  it("merges permissions additively and upgrades read to read_write", () => {
    expect(
      mergePermissions(
        { filesystem: [{ path: "src", access: "read" }], network: ["a.com"], mcpServers: ["github"] },
        { filesystem: [{ path: "src", access: "read_write" }, { path: "infra", access: "read" }], network: ["a.com", "b.com"], mcpServers: ["github", "slack"], secrets: ["TOKEN"] }
      )
    ).toEqual({
      filesystem: [{ path: "src", access: "read_write" }, { path: "infra", access: "read" }],
      network: ["a.com", "b.com"],
      mcpServers: ["github", "slack"],
      secrets: ["TOKEN"]
    });
  });

  it("merges intent changes without dropping the original plan", () => {
    const intent = { ...INTENT, id: "i", taskId: "t", status: "approved", createdAt: "", createdBy: { agentId: "a", agentType: "custom" }, plannedChanges: INTENT.plannedActions } as unknown as AgentIntent;
    const merged = mergeIntent(intent, { expectedFiles: ["infra/prod.tf", "src/auth/session.js"], expectedNetwork: ["Registry.Terraform.io"] });
    expect(merged.expectedFiles).toEqual(["src/auth/session.js", "infra/prod.tf"]);
    expect(merged.expectedNetwork).toEqual(["registry.terraform.io"]);
    expect(merged.constraints).toEqual(INTENT.constraints);
  });
});
