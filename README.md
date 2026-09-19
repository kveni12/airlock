# AgentGuard

AgentGuard governs AI coding-agent runs by recording intent and permissions, executing builders in disposable sandboxes, collecting normalized telemetry, comparing intent with behavior, reviewing changes, resolving findings in new sandboxes, and recording human approval. Lima VMs are the default runtime; Docker remains an optional compatibility provider.

This repository implements the backend workflow for:

`DECLARE INTENT -> RUN -> OBSERVE -> FIND -> REVIEW -> RESOLVE -> RE-REVIEW -> APPROVE`

## Requirements

- Node.js 22+
- npm
- Lima 2+ (`brew install lima` on macOS)
- macOS 13+ for the native Virtualization.framework (`vz`) runtime

## Quickstart (backend + UI)

```bash
npm install
npm run dev:all
```

Then open `http://localhost:3001`. `dev:all` installs the frontend dependencies if needed, seeds `data/agentguard-store.json` with the deterministic intent demo (only when the store does not exist yet; set `AGENTGUARD_SKIP_SEED=1` to skip), and starts the backend on `:3000` and the frontend on `:3001`. No Lima or Docker is needed for the seeded demo — it uses the opt-in `process` runtime.

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

## Phase 2 Governance Demo

After `npm run vm:setup` and while the backend is running, execute:

```bash
npm run demo:phase2
```

The deterministic demo:

1. declares an OAuth intent,
2. runs a builder in a disposable VM,
3. creates legitimate OAuth source and tests,
4. intentionally creates `infra/prod.tf` outside intent,
5. generates policy and intent-comparison findings with event evidence,
6. reviews every changed file,
7. sends the infrastructure finding to a resolver sandbox,
8. reruns tests and re-reviews the resulting diff,
9. marks the original finding resolved only after verification,
10. records human approval without modifying the developer checkout.

The script prints the builder run, finding, reviews, resolution, and final dashboard summary. `jq` is required.

## Intent Observability Demo

`npm run demo:intent` runs the full request → intent → permissions → behavior → result chain without a running server or sandbox runtime (it drives the HTTP API in-process and uses the opt-in, unsandboxed `process` runtime provider). Set `AGENTGUARD_RUNTIME_PROVIDER=lima` or `docker` to run the same demo inside a real sandbox.

1. persists the human request ("Fix the login/session bug … Do not modify database or infrastructure configuration. Do not add external dependencies.") and its deterministic analysis,
2. runs a read-only planner that declares structured intent, then compares request ↔ intent (aligned),
3. runs a builder that fixes `src/auth/session.js`, adds a regression test, runs `npm test`, and intentionally edits `infra/prod.tf` and adds `axios`,
4. produces independently observed intent → behavior findings for the two drifts through the existing telemetry/finding pipeline,
5. reviews, resolves both findings in resolver runs, re-reviews, and records approval,
6. prints the behavior summary with telemetry coverage, the alignment summary, the result summary, and the unified timeline.

Design and reconciliation notes: `docs/intent-observability-spec.md`.

## Agent Compatibility

AgentGuard is agent-agnostic at the runtime boundary. Any AI coding agent can run if it can be launched as a non-interactive command inside the selected base VM.

| Agent | Adapter kind | Default base VM | Authentication identifier |
| --- | --- | --- | --- |
| OpenAI Codex | `codex` | `agentguard-codex-base` | `OPENAI_API_KEY` |
| Claude Code | `claude_code` | `agentguard-claude-code-base` | `ANTHROPIC_API_KEY` |
| Cursor Agent | `cursor` | `agentguard-cursor-base` | `CURSOR_API_KEY` |
| Devin | `devin` | `agentguard-devin-base` | `DEVIN_API_KEY`, `DEVIN_ORG_ID` |

Build an agent-specific reusable base once:

```bash
npm run vm:setup-agent -- codex
npm run vm:setup-agent -- claude-code
npm run vm:setup-agent -- cursor
npm run vm:setup-agent -- devin
```

The first three commands install and verify their official CLI. The Devin base contains the AgentGuard bridge because Devin normally executes in its cloud environment. Every actual run still receives a fresh disposable clone.

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

Named adapters automatically select their agent-specific base. Override it only when you maintain a custom build:

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

Codex uses stable non-interactive `codex exec`. AgentGuard enables ephemeral JSON output and bypasses Codex's nested approval sandbox because execution is already contained by the disposable VM:

```bash
curl -sS -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "taskId": "task_codex_001",
    "agentId": "codex_builder_001",
    "repo": { "path": "'$PWD'/fixtures/demo-repo" },
    "agent": {
      "kind": "codex",
      "prompt": "Update the greeting implementation and run tests",
      "args": ["--model", "gpt-5.5"]
    },
    "permissions": {
      "filesystem": [{ "path": "/workspace/src", "access": "read_write" }],
      "network": ["api.openai.com"],
      "secrets": ["OPENAI_API_KEY"],
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
    "command": ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "Update the greeting implementation and run tests"]
  }
}
```

### Claude Code

Claude Code runs with print mode, streaming JSON output, no session persistence, and unattended permissions inside the VM:

```json
{
  "agentId": "claude_builder_001",
  "agent": {
    "kind": "claude_code",
    "prompt": "Fix the failing authentication tests",
    "args": ["--max-turns", "20"]
  },
  "permissions": {
    "secrets": ["ANTHROPIC_API_KEY"],
    "network": ["api.anthropic.com"]
  }
}
```

### Cursor

Cursor Agent runs in non-interactive print mode with structured output:

```json
{
  "agentId": "cursor_builder_001",
  "agent": {
    "kind": "cursor",
    "prompt": "Implement the requested endpoint and run tests"
  },
  "permissions": {
    "secrets": ["CURSOR_API_KEY"],
    "network": ["cursor.sh", "cursorapi.com"]
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
    "baseVm": "agentguard-devin-base",
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

### Any Other Coding Agent

Use `kind: "custom"`, provide its non-interactive command, and select a base VM containing the executable. No runtime-manager code change is required:

```json
{
  "agentId": "future_agent_001",
  "runtime": {
    "provider": "lima",
    "baseVm": "agentguard-future-agent-base"
  },
  "agent": {
    "kind": "custom",
    "command": ["future-agent", "run", "--non-interactive", "Fix the tests"]
  }
}
```

Filesystem, process, network-proxy, Git, policy, persistence, and SSE behavior is independent of the selected agent. Codex, Claude Code, and Cursor JSONL output receives best-effort semantic normalization. Other agents can use the protocol below without requiring a backend change.

## How Observability Works

AgentGuard distinguishes independently observed evidence from agent-reported activity:

- **Observed by the sandbox:** top-level process lifecycle, stdout/stderr, workspace creates/writes/deletes, proxy-aware network destinations, final Git changes, and policy violations.
- **Normalized from vendor output:** Codex, Claude Code, and Cursor structured output becomes stable `agent.*`, `process.command_*`, and `mcp.*` events.
- **Reported by a bridge or custom agent:** one JSON object per line prefixed with `AGENTGUARD_EVENT `. These events receive `metadata.reportedByAgent: true`; source-provided run IDs and trust fields are ignored.

Example custom-agent output:

```text
AGENTGUARD_EVENT {"category":"agent","action":"tool_call","resource":"shell","metadata":{"command":"npm test"}}
AGENTGUARD_EVENT {"category":"mcp","action":"tool_call","resource":"github/create_issue","metadata":{"arguments":{"title":"Test failure"}}}
```

Allowed self-reported categories are `agent`, `process`, and `mcp`. Filesystem, network, policy, secret, and runtime lifecycle events remain backend-owned so an agent cannot claim that its own behavior was allowed or independently observed.

Every output record is line- and size-bounded, ordered per run, sent through centralized secret redaction, persisted, and streamed over SSE. Unknown output becomes `process.output`; malformed explicit protocol messages generate `runtime.telemetry_degraded` rather than disappearing silently.

Representative live sequence:

```text
runtime.started
process.start
agent.message
agent.tool_call
process.command_start
process.output
filesystem.write
mcp.tool_call
mcp.tool_result
git.file_changed
git.diff_generated
process.exit
runtime.completed
```

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
POST /api/intents
POST /api/intents/generate
GET  /api/intents/:id
GET  /api/runs/:id/intent
GET  /api/findings
GET  /api/findings/:id
POST /api/findings/:id/dismiss
POST /api/findings/:id/resolve
GET  /api/resolutions/:id
POST /api/runs/:id/review
GET  /api/reviews
GET  /api/reviews/:id
GET  /api/reviews/:id/findings
POST /api/reviews/:id/approve
GET  /api/dashboard/summary
GET  /api/agents/:id/summary
```

`GET /api/agent-profiles` returns supported adapter kinds, default VM bases, recommended secret identifiers, execution modes, and `runtimeReady` for each local base.

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

After building the agent-specific bases, run the cross-agent smoke suite. It launches real disposable VMs for Codex, Claude Code, Cursor Agent, and the Devin bridge, verifies each installed executable, and checks run completion and cleanup:

```bash
npm run vm:test-agents
```

This smoke suite does not submit authenticated coding tasks. End-to-end vendor API behavior requires the corresponding credentials listed in the compatibility table.

The optional Docker integration test requires Docker and its runtime image:

```bash
npm run docker:build
RUN_DOCKER_TESTS=1 npm test
```

Run the complete Phase 2 governance integration test with Docker:

```bash
npm run phase2:test
```

## Security Limitations

This is a hackathon/MVP sandbox, not a hardened environment for arbitrary hostile code.

- Filesystem path permissions are stored and evaluated as policy warnings; they are not complete kernel-level enforcement.
- Filesystem reads are not traced.
- Child processes are visible when the agent's structured output reports them; kernel-level tracing of every subprocess is not implemented.
- VM isolation is materially stronger than a container boundary, but this is not yet a hardened multi-tenant sandbox.
- Network observability depends on tools honoring `HTTP_PROXY`/`HTTPS_PROXY`; direct socket traffic is not blocked.
- HTTPS bodies are not decrypted or inspected.
- The network proxy records destination host/port only.
- Generic MCP proxy enforcement is not implemented yet. MCP records emitted by supported JSONL adapters or the AgentGuard event protocol are observable but self-reported.
- The default reviewer is deterministic and operates on a bounded immutable data snapshot. A production reviewer-agent sandbox is represented by an interface but not provisioned as a maintained model-specific VM yet.
- Governance-enabled workspaces are retained for resolution chains; production deployments need a retention policy and garbage collector.
- Vendor output formats can change; unknown records safely fall back to sanitized `process.output` instead of being discarded.
- Devin runs remotely by design; AgentGuard can only observe actions and changes that its bridge imports into the disposable VM and event collector.
- JSON-file persistence is intentionally simple and not designed for high-concurrency production workloads.

## Product Boundary

This backend owns:

```text
DECLARE INTENT -> CONFIGURE ACCESS -> RUN -> OBSERVE -> COMPARE -> REVIEW -> FIND -> RESOLVE -> RE-REVIEW -> APPROVE
```

Approval is a recorded governance decision. It intentionally does not:

```text
APPLY TO ORIGINAL CHECKOUT -> COMMIT -> PUSH -> MERGE
```
