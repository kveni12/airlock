#!/usr/bin/env bash
set -euo pipefail

base_vm="${AGENTGUARD_BASE_VM:-agentguard-base}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl is required. On macOS, install it with: brew install lima" >&2
  exit 1
fi

if ! limactl list "${base_vm}" --format '{{.Status}}' >/dev/null 2>&1; then
  limactl create \
    --name "${base_vm}" \
    --vm-type vz \
    --cpus 2 \
    --memory 2 \
    --disk 12 \
    --mount-none \
    --containerd none \
    template:default
fi

limactl start "${base_vm}"
limactl shell "${base_vm}" sudo apt-get update
limactl shell "${base_vm}" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  bash ca-certificates curl git nodejs npm python3

limactl copy "${repo_root}/runtime/demo-agent.sh" "${base_vm}:/tmp/agentguard-demo-agent"
limactl copy "${repo_root}/runtime/phase2-demo-agent.sh" "${base_vm}:/tmp/agentguard-phase2-demo-agent"
limactl copy "${repo_root}/runtime/devin-agentguard-bridge.sh" "${base_vm}:/tmp/devin-agentguard-bridge"
limactl shell "${base_vm}" sudo install -m 0755 /tmp/agentguard-demo-agent /usr/local/bin/agentguard-demo-agent
limactl shell "${base_vm}" sudo install -m 0755 /tmp/agentguard-phase2-demo-agent /usr/local/bin/agentguard-phase2-demo-agent
limactl shell "${base_vm}" sudo install -m 0755 /tmp/devin-agentguard-bridge /usr/local/bin/devin-agentguard-bridge
limactl stop "${base_vm}"

echo "Lima base VM '${base_vm}' is ready."
