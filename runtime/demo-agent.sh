#!/usr/bin/env bash
set -euo pipefail

echo "AgentGuard demo agent starting"

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

npm test

curl -fsSL --max-time 5 http://example.com >/dev/null || true

echo "AgentGuard demo agent completed"
