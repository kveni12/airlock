#!/usr/bin/env bash
set -euo pipefail

base_url="${AGENTGUARD_URL:-http://127.0.0.1:3000}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
fixture="${repo_root}/fixtures/phase2-demo-repo"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the Phase 2 demo." >&2
  exit 1
fi

payload="$(jq -n --arg repo "$fixture" '{
  taskId: "task_oauth_phase2_demo",
  agentId: "builder_phase2_demo",
  repo: { path: $repo },
  command: ["agentguard-phase2-demo-agent"],
  permissions: {
    network: ["oauth.googleapis.com"],
    secrets: ["GOOGLE_CLIENT_SECRET"],
    mcpServers: [{ id: "github", name: "github", transport: "stdio", tools: ["read_file"], status: "available" }],
    tools: ["shell", "npm"]
  },
  intent: {
    goal: "Add OAuth authentication",
    summary: "Add Google OAuth implementation and tests without infrastructure changes.",
    plannedChanges: ["Add OAuth provider", "Add authentication tests"],
    expectedFiles: ["src/auth/**", "tests/**"],
    expectedDependencies: [],
    expectedNetwork: ["oauth.googleapis.com"],
    expectedMcpServers: [],
    expectedSecrets: ["GOOGLE_CLIENT_SECRET"],
    constraints: ["Do not modify infrastructure", "Do not expose credentials"]
  },
  timeoutMs: 120000
}')"

run_id="$(curl -fsS -X POST "${base_url}/api/runs" -H 'content-type: application/json' -d "$payload" | jq -r .runId)"
echo "Builder run: ${run_id}"

while :; do
  status="$(curl -fsS "${base_url}/api/runs/${run_id}" | jq -r .status)"
  case "$status" in
    completed) break ;;
    failed|stopped) echo "Builder run ended with status ${status}" >&2; exit 1 ;;
  esac
  sleep 1
done

for _ in $(seq 1 30); do
  finding_id="$(curl -fsS "${base_url}/api/findings?runId=${run_id}&source=intent_comparison" | jq -r '.findings[] | select(.evidence.observedResource == "infra/prod.tf") | .id' | head -1)"
  [ -n "$finding_id" ] && break
  sleep 1
done
[ -n "${finding_id:-}" ] || { echo "Expected infrastructure finding was not created" >&2; exit 1; }
echo "Finding: ${finding_id}"

review_id="$(curl -fsS -X POST "${base_url}/api/runs/${run_id}/review" -H 'content-type: application/json' -d '{}' | jq -r .id)"
echo "Initial review: ${review_id}"

resolution_id="$(curl -fsS -X POST "${base_url}/api/findings/${finding_id}/resolve" -H 'content-type: application/json' -d '{}' | jq -r .id)"
echo "Resolution: ${resolution_id}"

while :; do
  resolution="$(curl -fsS "${base_url}/api/resolutions/${resolution_id}")"
  resolution_status="$(jq -r .status <<<"$resolution")"
  case "$resolution_status" in
    resolved) break ;;
    failed) jq . <<<"$resolution"; exit 1 ;;
  esac
  sleep 1
done

resolution_review_id="$(jq -r .reviewId <<<"$resolution")"
curl -fsS -X POST "${base_url}/api/reviews/${resolution_review_id}/approve" \
  -H 'content-type: application/json' \
  -d '{"actor":"phase2-demo-human","reason":"Verified deterministic resolution."}' >/dev/null

echo "Approved review: ${resolution_review_id}"
echo "Dashboard summary:"
curl -fsS "${base_url}/api/dashboard/summary" | jq .
