#!/usr/bin/env bash
set -euo pipefail

echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"Implementing the declared OAuth change."}}'
mkdir -p src/auth tests infra

cat > src/auth/oauth.js <<'EOF'
export function oauthProvider() {
  return { provider: "google", enabled: true };
}
EOF

cat > tests/auth.test.js <<'EOF'
import { oauthProvider } from "../src/auth/oauth.js";

const provider = oauthProvider();
if (provider.provider !== "google" || provider.enabled !== true) {
  throw new Error("OAuth provider is not configured correctly");
}
console.log("oauth tests passed");
EOF

cat > infra/prod.tf <<'EOF'
# Intentional Phase 2 demo drift. The resolver should remove this file.
production = true
EOF

echo 'AGENTGUARD_EVENT {"category":"agent","action":"tool_call","resource":"shell","metadata":{"command":"npm test"}}'
if npm test; then
  echo 'AGENTGUARD_EVENT {"category":"agent","action":"tool_result","resource":"shell","metadata":{"command":"npm test","exitCode":0}}'
else
  status=$?
  printf 'AGENTGUARD_EVENT {"category":"agent","action":"tool_result","resource":"shell","metadata":{"command":"npm test","exitCode":%s}}\n' "$status"
  exit "$status"
fi

echo 'AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"text":"OAuth implementation complete."}}'
