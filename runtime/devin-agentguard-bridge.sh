#!/usr/bin/env bash
# Devin bridge for Periscope.
#
# Devin runs in its own cloud VM, so Periscope cannot sandbox it directly. This bridge runs
# inside the Periscope sandbox, drives a Devin session through the public API
# (https://docs.devin.ai/api-reference) and brings the outcome back into /workspace:
#
#   planner  (AGENTGUARD_WORKSPACE_ACCESS=read_only): asks Devin for the structured intent
#            (via structured_output) and prints it as an AGENTGUARD_EVENT agent.intent line.
#   builder  : asks Devin to push its work to branch agentguard/<run id> of the repo's origin,
#            then fetches that branch and applies the diff to /workspace so Periscope's
#            filesystem/git telemetry observes the resulting changes.
#
# Devin's own messages are relayed as agent.message events (agent-reported evidence). Devin's
# activity inside its cloud VM is NOT observed by Periscope; only the resulting diff is.
#
# Environment: DEVIN_API_KEY (required), DEVIN_API_URL (default https://api.devin.ai),
# DEVIN_SNAPSHOT_ID, DEVIN_MAX_ACU, DEVIN_POLL_INTERVAL_MS, DEVIN_BRIDGE_COMMAND (legacy:
# run an arbitrary command instead of the API client).
set -euo pipefail

prompt="${1:-${AGENTGUARD_PROMPT:-}}"
export AGENTGUARD_PROMPT="$prompt"
cd "${AGENTGUARD_WORKSPACE:-/workspace}"

if [ -n "${DEVIN_BRIDGE_COMMAND:-}" ]; then
  exec bash -lc "$DEVIN_BRIDGE_COMMAND"
fi

if [ -z "${DEVIN_API_KEY:-}" ]; then
  echo "devin-agentguard-bridge requires DEVIN_API_KEY (add it to the run's secrets) or DEVIN_BRIDGE_COMMAND." >&2
  exit 78
fi

exec node - <<'JS'
const { execFileSync } = require("node:child_process");

const apiUrl = (process.env.DEVIN_API_URL ?? "https://api.devin.ai").replace(/\/$/, "");
const apiKey = process.env.DEVIN_API_KEY;
const prompt = process.env.AGENTGUARD_PROMPT ?? "";
const runId = process.env.AGENTGUARD_RUN_ID ?? `local-${Date.now()}`;
const planning = process.env.AGENTGUARD_WORKSPACE_ACCESS === "read_only" || process.env.AGENTGUARD_RUN_PURPOSE === "planner";
const pollMs = Number(process.env.DEVIN_POLL_INTERVAL_MS ?? 10_000);
const branch = `agentguard/${runId}`;

const emit = (action, metadata) =>
  console.log(`AGENTGUARD_EVENT ${JSON.stringify({ category: "agent", action, metadata })}`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const stringList = { type: "array", items: { type: "string" } };
const intentSchema = {
  type: "object",
  required: ["goal", "interpretation", "plannedActions", "expectedFiles", "expectedDependencies", "expectedCommands", "expectedNetwork", "expectedMcpServers", "expectedSecrets", "expectedTools", "constraints"],
  properties: {
    goal: { type: "string" },
    interpretation: { type: "string" },
    plannedActions: stringList,
    expectedFiles: stringList,
    expectedDependencies: stringList,
    expectedCommands: stringList,
    expectedNetwork: stringList,
    expectedMcpServers: stringList,
    expectedSecrets: stringList,
    expectedTools: stringList,
    constraints: stringList,
    assumptions: stringList
  }
};

async function api(method, path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`Devin API ${method} ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function repoContext() {
  let origin, head;
  try { origin = git("remote", "get-url", "origin"); } catch { origin = undefined; }
  try { head = git("rev-parse", "HEAD"); } catch { head = undefined; }
  return { origin, head };
}

async function main() {
  const { origin, head } = repoContext();
  if (!planning && !origin) throw new Error("Builder mode needs the repository to have an 'origin' remote Devin can push to.");

  const context = [
    origin ? `Repository: ${origin}${head ? ` at commit ${head}` : ""}.` : "",
    planning
      ? "This is a read-only planning task: inspect the repository but do not change, commit or push anything. Answer with the structured output only."
      : `Create a branch named ${branch} from that commit, make your changes there, commit, and push the branch to origin. Do not open a pull request. Do not push to any other branch. Reply "done" when the branch is pushed.`
  ].filter(Boolean).join("\n");

  const session = await api("POST", "/v1/sessions", {
    prompt: `${prompt}\n\n${context}`,
    title: `Periscope ${planning ? "planner" : "builder"} ${runId}`,
    unlisted: true,
    tags: ["agentguard", runId],
    ...(process.env.DEVIN_SNAPSHOT_ID ? { snapshot_id: process.env.DEVIN_SNAPSHOT_ID } : {}),
    ...(process.env.DEVIN_MAX_ACU ? { max_acu_limit: Number(process.env.DEVIN_MAX_ACU) } : {}),
    ...(planning ? { structured_output_schema: intentSchema } : {})
  });
  emit("message", { text: `Devin session ${session.session_id} started: ${session.url}`, sessionId: session.session_id, sessionUrl: session.url });

  const seen = new Set();
  let details;
  for (;;) {
    details = await api("GET", `/v1/sessions/${session.session_id}`);
    for (const message of details.messages ?? []) {
      if (seen.has(message.event_id)) continue;
      seen.add(message.event_id);
      if (message.type === "devin_message") emit("message", { text: message.message, timestamp: message.timestamp });
    }
    const status = details.status_enum;
    if (status === "finished" || status === "expired") break;
    if (status === "blocked") {
      if (planning && details.structured_output) break;
      if (!planning && branchPushed(origin)) break;
      throw new Error(`Devin session ${session.session_id} is blocked waiting for input (${session.url}); Periscope runs are non-interactive.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (details.status_enum === "expired") throw new Error(`Devin session ${session.session_id} expired.`);

  if (planning) {
    if (!details.structured_output) throw new Error("Devin finished without structured intent output.");
    emit("intent", { intent: details.structured_output, sessionUrl: session.url });
    return;
  }

  git("fetch", "origin", branch);
  const files = git("diff", "--name-only", "HEAD", "FETCH_HEAD").split("\n").filter(Boolean);
  if (files.length > 0) {
    const patch = execFileSync("git", ["diff", "--binary", "HEAD", "FETCH_HEAD"]);
    execFileSync("git", ["apply", "--whitespace=nowarn"], { input: patch, stdio: ["pipe", "inherit", "inherit"] });
  }
  emit("message", {
    text: `Applied ${files.length} changed file(s) from ${branch}${details.pull_request?.url ? ` (PR ${details.pull_request.url})` : ""}`,
    files,
    sessionUrl: session.url
  });
}

function branchPushed(origin) {
  try { return git("ls-remote", "--heads", origin, branch).length > 0; } catch { return false; }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
JS
