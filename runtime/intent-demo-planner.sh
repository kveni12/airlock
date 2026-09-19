#!/usr/bin/env bash
# Deterministic planner: inspects the workspace read-only and emits structured intent.
set -euo pipefail

echo 'AGENTGUARD_EVENT {"category":"agent","action":"tool_call","resource":"filesystem","metadata":{"command":"read src/auth/session.js"}}'
cat src/auth/session.js >/dev/null

cat <<'INTENT'
AGENTGUARD_EVENT {"category":"agent","action":"intent","metadata":{"intent":{"goal":"Fix the login/session bug and add a regression test","interpretation":"Sessions are accepted after expiry. Correct the validity check in session handling and cover it with a regression test without touching database or infrastructure configuration or adding dependencies.","plannedActions":["Inspect session handling","Modify src/auth/session.js to reject expired sessions","Add a session regression test","Run authentication tests"],"expectedFiles":["src/auth/session.js","tests/auth/**"],"expectedDependencies":[],"expectedCommands":["npm test"],"expectedNetwork":[],"expectedMcpServers":[],"expectedSecrets":[],"expectedTools":["filesystem","shell"],"constraints":["Do not modify database or infrastructure configuration","Do not add external dependencies"],"assumptions":["The existing test runner (npm test) is sufficient"]}}}
INTENT
