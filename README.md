# AgentGuard

AgentGuard monitors AI coding-agent runs by creating a disposable virtual machine, executing a configured command, collecting normalized telemetry, and streaming events to the dashboard over SSE. Lima VMs are the default runtime; Docker remains an optional compatibility provider.

This repository currently implements the backend MVP for:

`CREATE SANDBOX -> EXECUTE -> OBSERVE`

## Requirements

- Node.js 22+
- npm
- Lima 2+ (`brew install lima` on macOS)
- macOS 13+ for the native Virtualization.framework (`vz`) runtime

## Install

```bash
npm install
```

## Set Up VM Runtime

Create the reusable, pre-provisioned base VM once:

```bash
npm run vm:setup
```

The base VM is named:

```text
agentguard-base
```

AgentGuard clones this stopped base for every run, mounts only that run's temporary workspace, executes the agent, and deletes the clone. On macOS, Lima uses Apple's Virtualization.framework by default.

Docker can still be selected explicitly with `runtime.provider: "docker"`; build its reusable image with `npm run docker:build`.

## Start Backend

```bash
npm run dev
```

Default API URL:

```text
http://localhost:3000
```

## Start Demo Run

Use the deterministic demo fixture:

```bash
curl -sS -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "taskId": "task_demo_001",
    "agentId": "demo_agent_001",
    "repo": {
      "path": "'$PWD'/fixtures/demo-repo"
    },
    "command": ["agentguard-demo-agent"],
    "expectedFiles": [
      "src/app.js",
      "src/generated-agent-file.js",
      "package.json"
    ],
    "permissions": {
      "filesystem": [
        { "path": "/workspace/src", "access": "read_write" },
        { "path": "/workspace/package.json", "access": "read_write" }
      ],
      "network": ["example.com"],
      "secrets": ["DEMO_API_TOKEN"],
      "mcpServers": [],
      "tools": ["git", "npm", "shell", "curl"]
    }
  }'
```

The response includes a `runId`. Query status:

```bash
curl -sS http://localhost:3000/api/runs/RUN_ID
```

## Agent Compatibility

AgentGuard is agent-agnostic at the runtime boundary. Any AI coding agent can run if it can be launched as a non-interactive command inside the selected base VM.

There are two supported ways to launch agents:

1. Universal command mode:

```json
{
  "agentId": "any_agent",
  "command": ["my-agent", "--non-interactive", "--task", "Fix the tests"]
}
```

2. Named adapter mode:

```json
{
  "agentId": "codex_001",
  "agent": {
    "kind": "codex",
    "prompt": "Implement OAuth login",
    "args": ["--model", "gpt-5.6-terra"]
  }
}
```

Named adapters resolve to commands, but they do not install proprietary CLIs. Clone and provision a separate Lima base VM when an agent needs custom tooling, then select it with `runtime.baseVm`:

```json
{
  "runtime": {
    "provider": "lima",
    "baseVm": "agentguard-codex-base"
  }
}
```

The resolved command is stored with the run; non-secret env var names are stored, but env values are passed only to the sandbox and are not persisted in run records.

Declared secret names are resolved from the backend process environment at run creation and injected only into that run. Secret values are registered with the per-run redactor before telemetry starts; event storage and SSE contain identifiers or `[REDACTED]`, never the resolved values.

### Codex

Codex can be run through command mode or the `codex` adapter when the selected base VM contains a compatible `codex` CLI:

```bash
curl -sS -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "taskId": "task_codex_001",
    "agentId": "codex_builder_001",
    "repo": { "path": "'$PWD'/fixtures/demo-repo" },
    "runtime": { "provider": "lima", "baseVm": "agentguard-codex-base" },
    "agent": {
      "kind": "codex",
      "prompt": "Update the greeting implementation and run tests",
      "args": ["--approval-mode", "never"]
    },
    "permissions": {
      "filesystem": [{ "path": "/workspace/src", "access": "read_write" }],
      "network": [],
      "secrets": [],
      "mcpServers": [],
      "tools": ["git", "npm", "shell"]
    }
  }'
```

Equivalent universal mode:

```json
{
  "agent": {
    "kind": "custom",
    "command": ["codex", "exec", "--approval-mode", "never", "Update the greeting implementation and run tests"]
  }
}
```

### Devin

Devin is often cloud-hosted, so AgentGuard distinguishes two cases:

- If Devin is available as a Linux CLI, run it with `agent.kind: "devin"` and a base VM containing that CLI.
- If Devin runs in the cloud, use `executionMode: "bridge"` and provide a bridge command that forwards the task to Devin and applies resulting patches inside `/workspace`.

Example bridge payload:

```json
{
  "agentId": "devin_001",
  "runtime": {
    "provider": "lima",
    "baseVm": "agentguard-base",
    "env": {
      "DEVIN_BRIDGE_COMMAND": "your-devin-cli-or-script --prompt \"$AGENTGUARD_PROMPT\" --apply-patch /workspace"
    }
  },
  "agent": {
    "kind": "devin",
    "executionMode": "bridge",
    "prompt": "Fix the failing auth tests"
  }
}
```

The base VM includes `devin-agentguard-bridge`, which executes `DEVIN_BRIDGE_COMMAND` from `/workspace`. Do not put raw secrets in this command string; pass secret values through your deployment environment or secret manager.

AgentGuard can fully observe the bridge process, workspace writes, git diff, proxy-aware network calls, and policy events. It cannot observe actions performed entirely inside Devin's remote environment unless the bridge exports those actions back as files, patches, logs, or events.

## Watch Events

Connect to the Server-Sent Events stream:

```bash
curl -N http://localhost:3000/api/runs/RUN_ID/stream
```

Or retrieve all persisted events:

```bash
curl -sS http://localhost:3000/api/runs/RUN_ID/events
```

## Other API Endpoints

```text
GET  /api/agent-profiles
POST /api/runs
GET  /api/runs
GET  /api/runs/:id
POST /api/runs/:id/stop
GET  /api/runs/:id/events
GET  /api/runs/:id/permissions
GET  /api/runs/:id/files
GET  /api/runs/:id/stream
```

`GET /api/agent-profiles` returns the supported adapter kinds and whether they require an explicit command, support prompts, or support bridge mode.

## VM Architecture

For each run, the Runtime Manager:

1. creates a unique `runId`,
2. copies the requested repository into a temporary workspace,
3. creates a git baseline in the temporary workspace if the source is not already a git checkout,
4. starts filesystem telemetry,
5. starts an AgentGuard HTTP/HTTPS proxy and injects proxy environment variables,
6. clones `agentguard-base` into a disposable `agentguard-{runId}` Lima VM,
7. mounts only the temporary workspace and exposes it inside the guest at `/workspace`,
8. executes the configured command,
9. collects filesystem, process, network, policy, and git events,
10. stops and deletes the disposable VM,
11. removes the temporary workspace by default,
12. preserves run history and events in `data/agentguard-store.json`.

The original developer checkout is not mounted into the VM and is not modified by the run. The base VM remains stopped between clones and is never used to execute a run directly.

## Tests

Run unit tests:

```bash
npm test
```

Run the compiler:

```bash
npm run build
```

The VM integration test is opt-in because it creates a disposable VM:

```bash
npm run vm:setup
npm run vm:test
```

The optional Docker integration test requires Docker and its runtime image:

```bash
npm run docker:build
RUN_DOCKER_TESTS=1 npm test
```

## Security Limitations

This is a hackathon/MVP sandbox, not a hardened environment for arbitrary hostile code.

- Filesystem path permissions are stored and evaluated as policy warnings; they are not complete kernel-level enforcement.
- Filesystem reads are not traced.
- Process telemetry captures the configured command, not every child process.
- VM isolation is materially stronger than a container boundary, but this is not yet a hardened multi-tenant sandbox.
- Network observability depends on tools honoring `HTTP_PROXY`/`HTTPS_PROXY`; direct socket traffic is not blocked.
- HTTPS bodies are not decrypted or inspected.
- The network proxy records destination host/port only.
- Generic MCP proxying is not implemented yet.
- JSON-file persistence is intentionally simple and not designed for high-concurrency production workloads.

## Product Boundary

This backend owns:

```text
CREATE SANDBOX -> EXECUTE -> OBSERVE
```

It does not yet implement:

```text
DECLARE INTENT -> REVIEW -> RESOLVE -> APPROVE
```
