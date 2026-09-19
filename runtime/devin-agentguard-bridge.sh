#!/usr/bin/env bash
set -euo pipefail

prompt="${1:-${AGENTGUARD_PROMPT:-}}"

if [ -z "${DEVIN_BRIDGE_COMMAND:-}" ]; then
  cat >&2 <<'EOF'
devin-agentguard-bridge requires DEVIN_BRIDGE_COMMAND.

Set DEVIN_BRIDGE_COMMAND to a non-interactive command that sends the task to Devin,
waits for completion, and applies the resulting patch or files inside /workspace.
AgentGuard can then observe the bridge process, filesystem changes, git diff, and policy events.
EOF
  exit 78
fi

export AGENTGUARD_PROMPT="$prompt"
cd /workspace
exec bash -lc "$DEVIN_BRIDGE_COMMAND"
