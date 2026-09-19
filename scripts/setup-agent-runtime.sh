#!/usr/bin/env bash
set -euo pipefail

agent_kind="${1:-}"
source_vm="${AGENTGUARD_BASE_VM:-agentguard-base}"

case "${agent_kind}" in
  codex)
    target_vm="agentguard-codex-base"
    ;;
  claude-code)
    target_vm="agentguard-claude-code-base"
    ;;
  cursor)
    target_vm="agentguard-cursor-base"
    ;;
  devin)
    target_vm="agentguard-devin-base"
    ;;
  *)
    echo "Usage: $0 <codex|claude-code|cursor|devin>" >&2
    exit 64
    ;;
esac

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl is required. Run npm run vm:setup first." >&2
  exit 1
fi

if ! limactl list "${source_vm}" --format '{{.Status}}' >/dev/null 2>&1; then
  echo "Base VM '${source_vm}' does not exist. Run npm run vm:setup first." >&2
  exit 1
fi

if ! limactl list "${target_vm}" --format '{{.Status}}' >/dev/null 2>&1; then
  limactl clone "${source_vm}" "${target_vm}"
fi

limactl start "${target_vm}"
stop_target_vm() {
  limactl stop "${target_vm}" >/dev/null 2>&1 || true
}
trap stop_target_vm EXIT

case "${agent_kind}" in
  codex)
    limactl shell "${target_vm}" sudo npm install -g @openai/codex
    limactl shell "${target_vm}" codex --version
    ;;
  claude-code)
    limactl shell "${target_vm}" sudo npm install -g @anthropic-ai/claude-code
    limactl shell "${target_vm}" claude --version
    ;;
  cursor)
    limactl shell "${target_vm}" bash -lc 'curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh && bash /tmp/cursor-install.sh && sudo install -m 0755 "$HOME/.local/bin/agent" /usr/local/bin/agent'
    limactl shell "${target_vm}" agent --version
    ;;
  devin)
    limactl shell "${target_vm}" sh -c 'command -v devin-agentguard-bridge >/dev/null'
    ;;
esac

echo "Agent runtime '${target_vm}' is ready for ${agent_kind}."
