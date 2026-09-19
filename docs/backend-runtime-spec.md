# Periscope Backend Runtime Spec

> Architecture update: after the initial Docker MVP was implemented, the runtime was changed to use disposable Lima VMs by default for stronger isolation. Docker remains an explicit compatibility provider. The implementation notes record this intentional drift from the original request.

## Intent

This backend implements the Periscope MVP runtime and observability path for coding-agent runs:

`CREATE SANDBOX -> EXECUTE -> OBSERVE`

The goal is to let the frontend and future reviewer agents ask:

- what a run was allowed to access,
- what the agent actually did,
- what files, network destinations, processes, and git changes were observed,
- whether the observed behavior drifted from declared expectations.

The implementation will create a modular TypeScript backend with:

- an HTTP API for run lifecycle and event access,
- a Runtime Manager that creates per-run temporary workspaces and disposable VMs,
- a reusable pre-provisioned Lima base VM,
- a central event collector and normalizer,
- a simple persistent JSON-file event store,
- live Server-Sent Events streaming,
- filesystem and git telemetry,
- basic process, network, secret-redaction, and policy events,
- a deterministic demo fixture.

Expected new files/directories:

- `src/api/` for Fastify routes and SSE handlers.
- `src/runtime/` for provider-neutral runtime lifecycle management plus Lima and Docker providers.
- `src/events/` for event schema, collection, streaming, and persistence.
- `src/policy/` for policy rules and sensitive path matching.
- `src/security/` for redaction and sanitization.
- `src/telemetry/` for filesystem, git, process, network, and dependency telemetry.
- `src/demo/` for demo repository generation and demo run helpers.
- `scripts/setup-vm-runtime.sh` for the reusable Lima base VM.
- `runtime/Dockerfile` and `runtime/bootstrap.sh` for the optional Docker provider.
- `tests/` for unit and runtime-oriented tests.
- `data/` at runtime for persisted run/event state.
- `README.md` for local demo instructions.

This work does not intend to:

- build the frontend dashboard,
- implement the full `DECLARE INTENT -> REVIEW -> RESOLVE -> APPROVE` workflow,
- harden the sandbox against hostile arbitrary code,
- perform HTTPS MITM or record request bodies,
- implement a complete generic MCP proxy,
- mount the host Docker socket into agent containers,
- mutate the developer's original checkout during a run.

## Architecture

### Runtime Manager

The Runtime Manager owns each run lifecycle:

1. validate the create-run request,
2. allocate a unique `runId`,
3. persist the run and permission snapshot,
4. create a temporary per-run workspace,
5. copy the requested repository into that workspace,
6. record initial git state,
7. start telemetry modules,
8. clone and start a disposable Lima VM through `limactl`,
9. wait for the agent command to complete or be stopped,
10. collect final filesystem and git state,
11. emit normalized events,
12. stop/delete the VM,
13. clean the temporary workspace according to configuration,
14. persist final run status and summaries.

Sandboxes are named predictably as `agentguard-{runId}`.

### VM Lifecycle

The default runtime uses a stopped, reusable Lima VM named `agentguard-base`. It contains shell, git, curl, Node.js/npm, and Periscope bootstrap scripts. Each run clones that base into a disposable VM. On macOS, Lima uses Apple's Virtualization.framework (`vz`).

For each run, Periscope creates a temporary copy of the repository and mounts only that directory into the VM. A guest-only symlink exposes it at `/workspace`. The original repository checkout is never mounted into the VM.

VM clones receive CPU and memory limits, and the agent command runs with a process-count limit. The base VM uses no default host mounts, and per-run clones receive only their temporary workspace. Docker remains available only when explicitly requested with `runtime.provider: "docker"`.

### Agent Execution

Periscope uses an agent adapter layer before sandbox creation. The universal adapter accepts any non-interactive command array and executes it inside `/workspace`. Named adapters include `generic`, `custom`, `codex`, `cursor`, `claude_code`, and `devin`; they resolve profile metadata into a tested non-interactive command, an agent-specific default base VM, and non-secret environment variables.

The runtime can use a per-run Lima base through `runtime.baseVm`, so teams can maintain bases containing Codex, Devin bridge tooling, or another coding-agent CLI. Periscope observes the command, workspace writes, git changes, network proxy events, and policy results regardless of which agent produced them.

Cloud-only agents are supported through bridge mode: the bridge command must apply patches or export events back inside the Periscope VM/workspace. The base VM includes `devin-agentguard-bridge`, which executes a configured `DEVIN_BRIDGE_COMMAND` from `/workspace`. Periscope does not claim visibility into work performed entirely in a remote agent environment that bypasses the VM.

Periscope records a sanitized `process.start` event for the resolved command and a `process.exit` event with exit code and timing. Deeper per-child process tracing is not guaranteed in the MVP.

### Telemetry Collection

Telemetry modules observe:

- filesystem creates/writes/deletes under the temporary workspace,
- git status/diff before and after execution,
- dependency manifest changes,
- process lifecycle for the configured command,
- HTTP/HTTPS proxy destination attempts where the agent honors proxy environment variables,
- declared secrets made available to the run by identifier only.

Sandbox providers also forward the agent process's stdout and stderr as ordered, bounded lines. An `AgentOutputMonitor` classifies those lines before they reach the Event Collector:

- Codex, Claude Code, and Cursor structured JSONL records are converted into stable Periscope events such as `agent.message`, `agent.reasoning`, `mcp.tool_call`, and `mcp.tool_result` where the source supplies the required fields.
- Any custom agent or remote bridge can emit `AGENTGUARD_EVENT {json}` on stdout. Periscope ignores source-supplied run identity and applies the current run's identity before collection.
- Lines that do not match a structured record become sanitized `process.output` events with stream and sequence metadata.
- Malformed explicit Periscope records produce `runtime.telemetry_degraded`; they do not silently disappear or fail the agent command.

Output records are size-bounded, serialized through a per-run queue, redacted by the central collector, persisted, and streamed over SSE. Raw terminal bytes and secret values are never written directly to the event store.

Telemetry sources emit raw observations to the Event Collector. They do not communicate directly with the frontend.

### Event Normalization

The Event Collector normalizes every event into the `AgentEvent` schema, adds missing IDs and timestamps, sanitizes metadata, persists the event, applies policy evaluation, and broadcasts to active subscribers.

### Event Persistence

For the MVP, storage is a simple durable JSON-file store under `data/agentguard-store.json`. It persists runs, events, permissions, and final git summaries. This avoids introducing database infrastructure before the product data model stabilizes.

### Real-Time Event Streaming

`GET /api/runs/:runId/stream` uses Server-Sent Events. New events are pushed as JSON payloads, and the route handles client disconnect cleanup.

### Policy/Risk Detection

Policy evaluation operates on normalized events. Initial rules:

- unexpected file modification,
- sensitive file modification,
- unapproved network destination,
- permission-scope violation.

Policy events are emitted as `category: "policy"` and `action: "violation"` with severity and rule metadata.

### Git/Diff Collection

Before execution, Periscope records branch, HEAD, and dirty status. After execution, it records changed files, summary stats, commits created during the run, dependency manifest changes, and a final diff string for future reviewer agents.

## Data Flow

`API request -> Runtime Manager -> disposable VM -> agent execution -> telemetry -> event collector -> normalizer -> database/event store -> SSE -> dashboard`

Detailed flow:

1. `POST /api/runs` validates input and calls the Runtime Manager.
2. Runtime Manager creates a persisted run with `pending`/`starting` status.
3. Permissions are stored separately as the run's "can access" snapshot.
4. A temporary workspace is created and populated from the requested repo path.
5. Filesystem and network telemetry start.
6. The Lima provider clones `agentguard-{runId}` from the reusable base VM.
7. The VM starts the configured agent command in `/workspace`.
8. Sandbox stdout/stderr and resource monitors emit raw observations.
9. The output monitor converts vendor JSONL, the `AGENTGUARD_EVENT` protocol, and unstructured lines into Periscope event inputs.
10. Event Collector normalizes, timestamps, redacts, persists, evaluates policy, and broadcasts.
10. SSE clients receive events live.
11. On completion or stop, final git telemetry is collected and stored.
12. Disposable VM and temporary workspace are cleaned up.
13. `GET` endpoints expose status, permissions, events, and changed files.

## Security Model

### Filesystem Access

The VM receives only the temporary workspace mounted from the host and exposed at `/workspace`. The original checkout is copied into that temporary workspace and is never mounted. Permission declarations are stored and used for policy checks; full kernel-level path enforcement within `/workspace` is not provided in the MVP.

### Network Access

The runtime sets `HTTP_PROXY` and `HTTPS_PROXY` to an Periscope proxy reachable through `host.lima.internal`. The proxy logs destinations, forwards allowed hosts, and blocks unapproved hosts where traffic uses the proxy. The MVP does not implement transparent proxying, packet capture, or HTTPS decryption.

### Secrets

The create-run request declares allowed secret identifiers. At run creation, the backend resolves those names from its own environment and injects available values into the sandbox without persisting them. Values are registered with a per-run redactor before telemetry starts. Event telemetry may include only secret names, never values. The centralized redaction layer sanitizes strings, arrays, objects, command arguments, MCP metadata, errors, and event metadata before persistence and streaming.

### MCP/Tool Access

The MVP stores declared MCP servers and tools in the permission snapshot. It normalizes `mcp.tool_call` and `mcp.tool_result` records emitted by supported agent JSONL or the Periscope bridge protocol. Those records are agent-reported evidence; a full generic intercepting and enforcing MCP proxy is not part of P0.

### VM Isolation

Every default run executes in a cloned Linux VM with its own kernel. The VM receives only the temporary workspace mount and is deleted after the run. This is stronger than container-only isolation, but is still an MVP and has not been hardened or audited for hostile multi-tenant workloads.

### Sensitive-Data Redaction

Redaction is applied before persistence and streaming. Known secret values, common token patterns, bearer tokens, and key/value pairs containing secret-like names are replaced with `[REDACTED]`.

## API Contracts

### Create Run

`POST /api/runs`

Request fields:

- `taskId: string`
- `agentId: string`
- `agent?: AgentProfile`
- `repo.path: string`
- `repo.branch?: string`
- `command?: string[]`
- `permissions: PermissionSnapshot`
- `expectedFiles?: string[]`
- `timeoutMs?: number`
- `cleanupWorkspace?: boolean`
- `runtime?: RuntimeConfig`

At least one of `command`, `agent.command`, or a named adapter profile that can derive a command must be supplied. For example, a Codex profile resolves to a `codex exec ...` command when no explicit command is supplied. A Devin bridge profile resolves to `devin-agentguard-bridge ...` unless a different binary or command is supplied.

Response:

```json
{
  "runId": "run_123",
  "sandboxId": null,
  "containerId": null,
  "runtimeProvider": "lima",
  "status": "starting"
}
```

Sandbox creation continues asynchronously, so `sandboxId` may initially be `null`. `containerId` is populated only for explicit Docker-provider runs.

### Run Status

`GET /api/runs/:id`

Returns run metadata, timestamps, exit code, failure reason, and git summary when available.

### Run Termination

`POST /api/runs/:id/stop`

Requests graceful stop. The run transitions through `stopping` to `stopped` or `failed`.

### Event Retrieval

`GET /api/runs/:id/events`

Returns chronological normalized events.

### Event Streaming

`GET /api/runs/:id/stream`

Returns `text/event-stream` with serialized `AgentEvent` payloads.

### Permission Retrieval

`GET /api/runs/:id/permissions`

Returns the permission snapshot captured at run creation.

### File/Git Retrieval

`GET /api/runs/:id/files`

Returns changed files, diff summary, dependency changes, commits, and final diff when available.

## Event Schema

```ts
interface AgentEvent {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  timestamp: string;
  category:
    | "agent"
    | "filesystem"
    | "process"
    | "network"
    | "secret"
    | "mcp"
    | "git"
    | "policy"
    | "runtime";
  action: string;
  resource?: string;
  allowed?: boolean;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  metadata?: Record<string, unknown>;
}
```

Supported MVP event actions include:

- `runtime.started`
- `runtime.completed`
- `runtime.failed`
- `runtime.telemetry_degraded`
- `agent.message`
- `agent.reasoning_summary`
- `agent.tool_call`
- `agent.tool_result`
- `filesystem.create`
- `filesystem.write`
- `filesystem.delete`
- `process.start`
- `process.exit`
- `process.output`
- `process.command_start`
- `process.command_exit`
- `network.request`
- `network.blocked`
- `secret.available`
- `secret.access`
- `mcp.tool_call`
- `mcp.tool_result`
- `git.file_changed`
- `git.commit`
- `git.diff_generated`
- `git.dependency_added`
- `git.dependency_removed`
- `policy.violation`

Actions are stored without duplicating category when the category already supplies context, for example `{ category: "runtime", action: "started" }`.

## Known MVP Limitations

- The sandbox is not hardened for hostile code.
- Filesystem reads are not traced; creates, writes, deletes, and git changes are prioritized.
- Child processes are visible when reported by structured agent output; kernel-level tracing is not implemented.
- Network monitoring depends on proxy-aware tooling inside the VM.
- HTTPS traffic is not decrypted; only host/port are observed.
- MCP calls emitted by supported structured output or the Periscope event protocol are observable, but a generic enforcing MCP proxy is not implemented.
- JSON-file persistence is suitable for MVP demos, not concurrent production scale.
- Permission rules are policy warnings by default rather than hard enforcement.
- Dependency diffing is basic and focuses on common manifest formats.
- Lima must be installed and `npm run vm:setup` must complete before default VM runs.

## Implementation Notes

Completed:

- Created a TypeScript/Fastify backend with the required run APIs.
- Refactored runtime execution behind a provider interface with Lima as the default and Docker as an explicit fallback.
- Added a disposable per-run Lima VM lifecycle: clone, start, execute, stop, and delete.
- Added `scripts/setup-vm-runtime.sh` to provision the reusable `agentguard-base` VM.
- Restricted Lima clones to a single per-run temporary workspace mount and exposed it as `/workspace` through a guest-only symlink.
- Added final filesystem baseline reconciliation so VM-mounted writes are recorded even when host filesystem notifications are delayed or dropped.
- Added an agent adapter layer with generic, custom, Codex, and Devin profiles.
- Added first-class Claude Code and Cursor profiles, agent-specific VM defaults, reproducible base builders, and executable preflight checks.
- Added ordered stdout/stderr capture to both Lima and Docker providers, vendor JSONL normalization, a generic `AGENTGUARD_EVENT` bridge protocol, bounded raw-output fallback, and explicit degraded-telemetry events.
- Added per-run runtime selection for agent-specific Lima bases or Docker images.
- Added non-secret runtime/agent environment injection while persisting only environment variable names.
- Added Docker SDK-based runtime orchestration using `dockerode`.
- Added a reusable runtime image in `runtime/Dockerfile`.
- Added per-run temporary workspace copying so the original checkout is not modified.
- Added normalized `AgentEvent` types, event collection, persistence, and SSE broadcasting.
- Added JSON-file persistence for runs, events, permissions, and git summaries.
- Added filesystem create/write/delete monitoring with `chokidar`.
- Added initial/final git state, changed-file, diff, commit, and dependency-change collection.
- Added permission snapshot retrieval.
- Added basic process start/exit telemetry for the configured command.
- Added basic HTTP/HTTPS proxy telemetry and blocking for proxy-aware tools.
- Added secret identifier events and centralized redaction for telemetry metadata.
- Added host-environment secret resolution, per-run sandbox injection, and value-aware redaction before persistence or SSE broadcast.
- Added policy rules for unexpected files, sensitive files, network scope, and filesystem permission scope.
- Added a deterministic demo fixture and `agentguard-demo-agent` script.
- Added `devin-agentguard-bridge` to both base runtimes for cloud-agent bridge workflows.
- Added README instructions for VM setup, optional Docker image build, backend start, demo run, SSE, and tests.
- Added tests for event collection, redaction, policy, an opt-in Docker runtime integration path, and an opt-in four-agent Lima smoke suite.
- Verified Docker locally by starting Docker Desktop, building `agentguard-runtime:latest`, running the opt-in Docker integration test, and creating a real API demo run that completed in a container.
- Installed Lima 2.2.0 locally, provisioned `agentguard-base`, and passed the real disposable-VM integration test with file and Git telemetry plus VM cleanup.
- Provisioned and verified reusable agent bases for Codex CLI 0.155.1, Claude Code 2.1.278, and Cursor Agent 2026.09.18-9a7762b, plus the Devin bridge base.
- Passed a real cross-agent smoke suite that launched disposable VMs through `RuntimeManager`, selected each profile's base automatically, verified the installed executable, recorded successful completion, and removed each clone.
- Passed real Lima and Docker integration tests that carried raw and structured agent output through the provider boundary into persisted normalized events.
- Ran the observability-enabled deterministic demo through `POST /api/runs`; it completed in a disposable VM and persisted a 34-event timeline containing agent protocol, process output, filesystem, network, Git, dependency, policy, and runtime events.

Changed from original intent:

- Because the GitHub repository was empty, the backend was scaffolded from scratch rather than adapted to an existing stack.
- At the user's direction, the final default runtime changed from Docker containers to cloned Lima VMs for a stronger isolation boundary. Docker support was retained as an opt-in provider to preserve portability and existing integrations.
- Persistence uses a durable JSON store under `data/agentguard-store.json` instead of a relational database, because no existing database was present.
- `POST /api/runs` returns immediately while sandbox creation continues asynchronously. `GET /api/runs/:id` exposes the populated `sandboxId`; `containerId` is retained only for Docker compatibility.
- Non-git source directories receive a temporary git baseline inside the copied workspace so demo and fixture runs still produce git diffs without modifying the original source directory.

Mocked, incomplete, or limited:

- The Docker integration test is gated behind `RUN_DOCKER_TESTS=1` because it requires Docker Desktop/Engine and the runtime image.
- The VM integration test is gated behind `RUN_VM_TESTS=1` (or `npm run vm:test`) because it creates a real disposable VM.
- Agent setup scripts install Codex, Claude Code, and Cursor CLIs into reusable bases. Real authenticated coding tasks were not run because vendor API credentials were not provided.
- Cloud-only Devin execution is observable only through a bridge that exports patches/logs/events back into the Periscope VM/workspace.
- Codex, Claude Code, and Cursor JSONL receive best-effort normalization. Unknown or changed vendor records fall back to `process.output`; proprietary activity not emitted by a CLI or bridge remains invisible.
- Filesystem reads are not observed.
- Process telemetry independently captures the configured top-level command. Child commands are visible only when reported by structured agent output.
- Network visibility depends on `HTTP_PROXY`/`HTTPS_PROXY` being honored by the agent process.
- MCP output records are normalized and streamed, but no generic intercepting or enforcing MCP proxy is implemented.
- Permission violations are emitted as policy events; per-path declarations within `/workspace` are not kernel-enforced. The VM mount boundary itself is enforced by exposing only the temporary workspace.
- Dependency change detection is intentionally basic and focused on common manifest formats.

Known security limitations:

- This remains an MVP/hackathon sandbox, not a hardened environment for hostile code.
- A VM provides a separate guest kernel and stronger isolation than Docker, but the Lima configuration and host sharing path have not undergone a production security audit.
- Proxy-aware network controls can be bypassed by software that opens direct sockets; true egress enforcement requires VM firewall or network-layer controls.
- HTTPS traffic is not decrypted or inspected.
- Secret values must not be included in requests or commands; the redaction layer reduces exposure risk but is not a formal DLP system.
- JSON-file persistence is not suitable for high-concurrency production deployments.

Next highest-priority backend tasks:

- Add automated CI coverage for both Lima and Docker integration paths on capable runners.
- Build, version, and publish maintained base VMs for the supported coding agents.
- Add credential-backed end-to-end tests in a secure CI environment for Codex, Claude Code, Cursor Agent, and Devin.
- Add startup health checks for Lima availability, base VM state, disk capacity, and virtualization support.
- Add child-process telemetry through guest-side instrumentation.
- Add VM firewall-based egress enforcement and stronger path enforcement within `/workspace`.
- Add a real MCP proxy for tool-call telemetry.
- Replace JSON persistence with the production database once the project chooses one.
- Add API schema validation and richer error responses.
- Address npm audit findings before production deployment.
