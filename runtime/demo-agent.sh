#!/usr/bin/env bash
set -euo pipefail

echo "AgentGuard demo agent starting"
echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"Preparing the demo workspace changes."}}'

mkdir -p src config

if [ -f src/app.js ]; then
  printf '\nexport function featureFlag() { return "agentguard-demo"; }\n' >> src/app.js
fi

cat > src/generated-agent-file.js <<'EOF'
export function generatedByAgentGuardDemo() {
  return "demo";
}
EOF

if [ -f package.json ]; then
  node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.dependencies = { ...(pkg.dependencies || {}), "left-pad": "1.3.0" };
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'
fi

cat > config/demo-sensitive-change.txt <<'EOF'
This file intentionally triggers the sensitive-file policy for the AgentGuard demo.
EOF

echo 'AGENTGUARD_EVENT {"category":"agent","action":"tool_call","resource":"shell","metadata":{"command":"npm test"}}'
if npm test; then
  echo 'AGENTGUARD_EVENT {"category":"agent","action":"tool_result","resource":"shell","metadata":{"command":"npm test","exitCode":0}}'
else
  test_exit=$?
  printf 'AGENTGUARD_EVENT {"category":"agent","action":"tool_result","resource":"shell","metadata":{"command":"npm test","exitCode":%s}}\n' "$test_exit"
  exit "$test_exit"
fi

curl -fsSL --max-time 5 http://example.com >/dev/null || true

echo "AgentGuard demo agent completed"
echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"Demo task completed."}}'
