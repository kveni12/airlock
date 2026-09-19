# AgentGuard Backend Phase 2 Spec

## Intent

Phase 2 moves AgentGuard from a sandbox and telemetry backend into an agent-governance and review backend:

`DECLARE INTENT -> CONFIGURE ACCESS -> RUN -> OBSERVE -> COMPARE -> REVIEW -> FIND -> RESOLVE -> RE-REVIEW -> APPROVE`

The existing runtime, agent adapters, telemetry modules, event collector, redaction, persistence, SSE, and policy engine remain the execution foundation. Phase 2 adds product-level state above those components instead of duplicating them.

This phase will add:

- persisted structured agent intent,
- deterministic intent-versus-behavior analysis,
- a unified finding model for policy, comparison, and reviewer findings,
- compact behavior summaries with source-event references,
- a reviewer abstraction with validated structured output,
- per-file review coverage,
- resolution attempts that run in a new sandbox and preserve the original evidence,
- re-review and human approval state,
- dashboard and agent summary APIs,
- first-class MCP configuration,
- explicit evidence provenance and verification strength.

Why these components are necessary:

- Intent records what the builder claimed it would do before implementation.
- Permissions record what AgentGuard allowed, independently from intent.
- Telemetry records what happened, independently from both intent and permissions.
- Deterministic analysis creates explainable findings without an opaque score.
- A separate reviewer catches defects that simple allowlists cannot express.
- Resolution history makes remediation auditable rather than erasing the original finding.
- Approval records a human governance decision without merging into the source checkout.

Expected files to add:

- `src/intent/intentService.ts`
- `src/analysis/behaviorAnalyzer.ts`
- `src/findings/findingService.ts`
- `src/review/reviewer.ts`
- `src/review/reviewService.ts`
- `src/resolution/resolutionService.ts`
- `src/dashboard/summaryService.ts`
- focused Phase 2 tests under `tests/`
- a Phase 2 deterministic demo script and/or fixture additions

Expected files to modify:

- `src/types.ts` for governance models and evidence provenance,
- `src/store/jsonStore.ts` for canonical persisted collections and migrations from the Phase 1 JSON shape,
- `src/events/eventCollector.ts` for global event subscribers and evidence normalization,
- `src/runtime/runtimeManager.ts` for terminal-run waiting and retained governance workspaces,
- `src/app.ts` for Phase 2 API routes,
- `src/policy/policyEngine.ts` only where policy metadata must map cleanly into findings,
- `runtime/demo-agent.sh`, fixtures, README, and package scripts for the governance demo.

This phase will not:

- replace the working Lima or Docker providers,
- replace SSE or the event collector,
- migrate persistence to PostgreSQL,
- add authentication, users, billing, queues, Kubernetes, or deployment infrastructure,
- merge approved changes into the developer checkout,
- claim kernel-level process, filesystem-read, or direct-socket observability,
- perform HTTPS interception,
- implement a generic enforcing MCP proxy,
- claim that agent-reported evidence was independently observed,
- use an opaque AI-generated risk score.

## Architecture

### Canonical Concepts

AgentGuard keeps these concepts separate:

1. **Intent**: what the builder says it plans to do.
2. **Permissions**: what AgentGuard allows the run to access.
3. **Observed behavior**: independently observed or explicitly agent-reported events.
4. **Findings**: product-level concerns derived from evidence.
5. **Review**: a bounded evaluation of a completed run and its changed files.
6. **Resolution attempt**: a new sandboxed run intended to address a finding.
7. **Approval**: a human decision that the reviewed result is acceptable for later application or merge.

### Intent Service

`IntentService` validates and persists `AgentIntent` records. Create-run requests may embed structured intent or reference an existing intent ID. The service normalizes expected workspace paths, dependency names, network hostnames, secret identifiers, and MCP names before persistence.

Intent generation has two paths:

- caller-supplied structured intent,
- planner-agent generation through the existing runtime and adapter abstraction.

Planner mode asks the configured agent to emit a structured `agent.intent` record. The planner runs against a disposable repository copy, and its workspace is discarded. Returned data is validated before it can be attached to a builder run. Missing or malformed output produces `runtime.intent_generation_failed`; AgentGuard does not silently substitute an empty intent.

### Behavior Analyzer

`BehaviorAnalyzer` combines the intent, permission snapshot, normalized events, and final Git summary into a compact `BehaviorSummary` and deterministic findings.

Checks include:

- changed file outside expected intent paths,
- added dependency outside expected dependencies,
- contacted host outside expected network destinations,
- accessed secret outside expected secrets when evidence exists,
- used MCP server outside expected MCP servers,
- informational configured-but-unused resources,
- tests not observed or observed failing where evidence exists.

Every deterministic finding keeps event IDs and declared/observed resources. Findings based on Git state use Git event IDs and diff snippets where available.

### Finding Service

`FindingService` is the canonical lifecycle owner for policy, intent-comparison, and reviewer findings. It supports filtering, evidence retrieval, dismissal, and guarded state transitions.

Policy events are converted into findings through a global Event Collector subscription. The original policy event remains unchanged and its ID is stored in finding evidence.

Findings are append-oriented. Resolution attempts never overwrite the original title, description, source, or evidence.

### Reviewer Architecture

The reviewer is separate from the builder by construction. It receives a bounded `ReviewerInput` containing:

- task and run identifiers,
- normalized intent,
- permission snapshot,
- compact behavior summary,
- changed files and bounded Git diff,
- dependency changes,
- observed test evidence,
- deterministic policy/comparison findings.

It does not receive a writable builder workspace. The default deterministic reviewer operates only on this immutable data object. A pluggable structured reviewer may run in a separate disposable sandbox in a later deployment; its output uses the same validator.

The Phase 2 reviewer abstraction supports:

- `DeterministicReviewer`, used by tests and the complete local demo,
- validated externally supplied structured reviewer output for agent/bridge integration,
- failure handling that marks the review failed and emits `runtime.reviewer_failed` without crashing or corrupting the builder run.

Structured reviewer output includes a summary, verdict, findings, and an explicit list of files actually reviewed. Only listed files move from `pending` to `clean` or `finding`. This prevents fake coverage.

### Resolver Architecture

Resolution never mutates the original checkout or original builder workspace. Governance-enabled builder workspaces are retained temporarily. A resolution attempt creates a new run whose source is the latest retained workspace in the resolution chain. Runtime Manager copies that source into a fresh temporary workspace and executes the configured resolver through the existing agent adapter/runtime path.

The resolver receives:

- original intent,
- immutable finding and evidence,
- relevant file and current diff,
- a focused remediation prompt,
- permission snapshot.

The default deterministic demo resolver can revert a safely validated relative file and run tests. Production callers may provide any supported resolver agent profile or explicit command.

After the resolver run:

1. the attempt records changed files, resulting diff, and test evidence,
2. the finding moves to `re_reviewing`,
3. deterministic comparison and a new review run against the resolution result,
4. the original finding is marked `resolved` only if the targeted condition is absent and the resolver run/tests succeeded,
5. otherwise it returns to `open` with the unsuccessful attempt preserved.

### Approval

`POST /api/reviews/:id/approve` records a human approval timestamp, actor/reason when supplied, and a governance event. Approval means AgentGuard considers the reviewed run acceptable for later application or merge. It does not copy files, commit, push, or merge.

### Dashboard Views

Dashboard and agent summary services derive responses from canonical runs, permissions, intents, events, reviews, and findings. They do not maintain duplicate counters.

Risk summaries are transparent counts by finding severity and deterministic finding type. No synthetic security score is produced.

## Data Models

### AgentIntent

```ts
interface AgentIntent {
  id: string;
  taskId: string;
  runId?: string;
  goal: string;
  summary: string;
  plannedChanges: string[];
  expectedFiles: string[];
  expectedDependencies: string[];
  expectedNetwork: string[];
  expectedMcpServers: string[];
  expectedSecrets: string[];
  constraints: string[];
  createdBy: { agentId: string; agentType: string };
  createdAt: string;
}
```

### Finding

```ts
interface Finding {
  id: string;
  taskId: string;
  runId: string;
  reviewId?: string;
  source: "policy" | "intent_comparison" | "reviewer";
  type: "security" | "spec_drift" | "permission" | "network" |
    "dependency" | "tests" | "code_quality" | "sensitive_change" | "other";
  severity: EventSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidence?: {
    eventIds?: string[];
    diffSnippet?: string;
    observedResource?: string;
    declaredResource?: string;
  };
  status: "open" | "resolving" | "re_reviewing" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
  dismissedAt?: string;
  dismissal?: { reason?: string; actor?: string };
}
```

### Review and FileReview

```ts
interface Review {
  id: string;
  taskId: string;
  runId: string;
  builderAgentId: string;
  reviewerAgentId: string;
  status: "pending" | "reviewing" | "needs_human" | "approved" | "failed";
  filesTotal: number;
  filesReviewed: number;
  cleanFiles: number;
  filesWithFindings: number;
  summary?: string;
  fileReviews: FileReview[];
  createdAt: string;
  completedAt?: string;
  approvedAt?: string;
  approval?: { actor?: string; reason?: string };
  failureReason?: string;
}

interface FileReview {
  path: string;
  status: "pending" | "reviewing" | "clean" | "finding";
  findingIds: string[];
}
```

### ResolutionAttempt

```ts
interface ResolutionAttempt {
  id: string;
  findingId: string;
  taskId: string;
  originalRunId: string;
  resolutionRunId?: string;
  reviewId?: string;
  resolverAgentId: string;
  status: "pending" | "running" | "re_reviewing" | "resolved" | "failed";
  filesChanged: string[];
  resultingDiff?: string;
  testResult?: { passed: boolean; exitCode?: number | null; eventIds: string[] };
  reReviewResult?: { passed: boolean; summary: string };
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}
```

### MCPServer

```ts
interface MCPServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse" | "other";
  tools?: string[];
  status: "available" | "connected" | "disabled";
}
```

Permission snapshots accept configured MCP server records while preserving compatibility with existing string names.

### Evidence Provenance

Every event gains:

```ts
evidenceSource?: "runtime" | "filesystem" | "proxy" | "git" | "agent_reported" | "reviewer";
verification?: "independent" | "agent_reported" | "inferred";
correlationId?: string;
```

Default provenance is assigned centrally by Event Collector. Filesystem, proxy, Git, and runtime lifecycle evidence is independent. Agent JSONL/bridge activity is agent-reported. Policy and deterministic comparison conclusions are inferred. Reviewer findings are reviewer evidence.

## API Changes

### Intent

- `POST /api/intents`
- `POST /api/intents/generate`
- `GET /api/intents/:id`
- `GET /api/runs/:id/intent`

`POST /api/runs` accepts either `intent`, `intentId`, or no intent for backward compatibility. Governance review requires an attached intent.

### Findings

- `GET /api/findings`
- `GET /api/findings/:id`
- `POST /api/findings/:id/dismiss`
- `POST /api/findings/:id/resolve`

Filters: `status`, `severity`, `runId`, `taskId`, and `source`.

### Reviews

- `POST /api/runs/:id/review`
- `GET /api/reviews`
- `GET /api/reviews/:id`
- `GET /api/reviews/:id/findings`
- `POST /api/reviews/:id/approve`

### Resolution

- `GET /api/resolutions/:id`

The resolve endpoint returns an attempt immediately; clients poll the resolution endpoint or consume run SSE for progress.

### Dashboard

- `GET /api/dashboard/summary`
- `GET /api/agents/:id/summary`

## Security Assumptions

- Existing VM/container isolation and redaction rules remain in force.
- Reviewer input is bounded and sanitized; unbounded raw event history is excluded.
- The default reviewer receives no filesystem path and therefore cannot modify builder output.
- A future agent reviewer must execute in its own disposable sandbox with a read-only snapshot.
- Resolver paths are normalized relative workspace paths; absolute paths and traversal are rejected.
- Resolver execution occurs in a new sandbox and temporary workspace.
- Original intent, findings, evidence, and diffs are immutable historical records.
- Reviewer and resolver structured output is untrusted input and validated before persistence.
- Agent-reported MCP/tool activity remains explicitly marked as agent-reported.
- Approval has no merge/apply side effect.

## Data Flow

```text
intent declaration/generation
          |
          v
intent store + permission snapshot
          |
          v
existing Runtime Manager -> disposable builder VM -> Event Collector
          |                                      |
          |                                      v
          +-----------------------------> behavior summary
                                                 |
                  intent + permissions + events + git
                                                 |
                                                 v
                                      deterministic findings
                                                 |
                                                 v
                                      separate reviewer input
                                                 |
                                                 v
                                     review + file coverage
                                                 |
                                    human dismiss/resolve
                                                 |
                                                 v
                                      fresh resolver sandbox
                                                 |
                                       tests + new diff
                                                 |
                                                 v
                                             re-review
                                                 |
                                                 v
                                           human approval
```

## Testing Strategy

Unit tests will cover:

- valid and malformed intent,
- expected-resource normalization,
- file/dependency/network comparison,
- finding creation, filtering, evidence, and transitions,
- structured reviewer parsing and malformed output,
- exact file review coverage,
- reviewer failure,
- resolution transitions and unsuccessful resolution,
- approval persistence and event generation,
- dashboard risk counts and configured-versus-observed summaries.

An end-to-end test will exercise:

`intent -> run -> observe -> analyze -> review -> resolve -> re-review -> approve`

The deterministic test uses the existing runtime abstractions and a controlled resolver command. Real Lima execution remains opt-in where host virtualization is required.

## Implementation Notes

### Completed

- Added durable `AgentIntent`, `Finding`, `Review`, `FileReview`, `ResolutionAttempt`, `BehaviorSummary`, and `MCPServer` models.
- Added backward-compatible JSON-store migration defaults and CRUD operations for all Phase 2 records.
- Added embedded or referenced intent on `POST /api/runs`; intent-backed workspaces are retained for review/resolution chains.
- Added strict intent parsing, path/dependency/hostname/name normalization, and planner-output parsing.
- Added `POST /api/intents/generate` with a structured-output path and a planner-run path through the existing runtime/agent adapters.
- Added event `evidenceSource`, `verification`, and `correlationId`; Event Collector assigns conservative provenance centrally.
- Added a global event subscription and automatic conversion of policy violations into unified findings with original event references.
- Added deterministic behavior summaries and intent comparisons for files, dependencies, network destinations, observed secret access, MCP use, declared-but-unused MCP servers, and test execution.
- Added filtering, dismissal reasons, guarded finding transitions, and evidence preservation.
- Added a reviewer interface, deterministic reviewer, validated structured-output reviewer, bounded reviewer input, explicit reviewed-file lists, and exact per-file coverage.
- Added reviewer failure persistence and `runtime.review_reviewer_failed` events without changing the completed builder run.
- Added asynchronous resolver runs using the existing Runtime Manager. Resolution starts from the latest retained result but executes in a new temporary workspace and disposable sandbox.
- Added resolver diff/test capture, re-review, unsuccessful-attempt preservation, and verification-gated resolution.
- Added related-finding reconciliation so policy and intent findings for the same corrected final-state condition close together without deleting their original records.
- Added human approval persistence and approval events with no checkout/merge side effect.
- Added dashboard summary and agent configured-versus-observed APIs, including transparent deterministic risk counts.
- Added first-class MCP server configuration while retaining string compatibility.
- Updated Git telemetry to report exact untracked paths and include untracked file contents in final diffs.
- Added an OAuth governance fixture, VM/Docker runtime demo agent, and `npm run demo:phase2` API orchestration script.
- Added `npm run phase2:test`, which passed the full Docker workflow: intent, builder execution, observation, findings, review, resolver sandbox, tests, re-review, resolution, and approval.
- Passed 37 default tests covering intent, normalization, analysis, findings, evidence, reviewer parsing/failure, file coverage, resolution success/failure, approval, summaries, redaction, telemetry, and exact untracked diffs.
- Ran the packaged Phase 2 demo successfully through the default Lima VM runtime after updating `agentguard-base`.

### Changes From Original Plan

- The default reviewer is deterministic rather than a model-backed agent. It is still separate from the builder and receives only an immutable bounded data object, so it cannot modify the builder workspace.
- Externally produced reviewer JSON can be validated and persisted through the reviewer abstraction, but AgentGuard does not yet launch a maintained reviewer-model VM itself.
- No read-only filesystem snapshot is passed to the default reviewer because it receives no filesystem path at all. This is stricter for mutation prevention, but it limits deep source inspection to the bounded diff supplied in `ReviewerInput`.
- Resolution endpoints return `202` and run asynchronously. Clients use `GET /api/resolutions/:id` or run SSE to follow progress.
- Findings for corrective deletion can still be emitted as raw policy history during a resolver run. Once final-state verification succeeds, related findings transition to resolved; their events and original evidence remain intact.

### Mocked Or Incomplete

- The deterministic reviewer confirms explainable checks but is not a substitute for a capable model reviewing implementation correctness.
- Structured external reviewer output is supported, but generic reviewer-agent sandbox launch/configuration is not yet exposed in the API.
- Planner-agent intent generation is implemented through existing adapters but was not tested with paid vendor credentials; deterministic structured output parsing is fully tested.
- Resolver requests may use existing agent profiles or commands, but automated tests use the deterministic revert-and-test resolver.
- Test results are inferred from sandbox exit status and normalized test command evidence; framework-level test counts are not parsed generically.
- Generic MCP interception/enforcement remains unimplemented.
- Governance workspaces are retained for resolution chains but do not yet have expiration, archival, or garbage-collection policy.

### Evidence Strength

Independently observed:

- runtime lifecycle and top-level process execution,
- captured stdout/stderr bytes,
- filesystem create/write/delete notifications and final reconciliation,
- Git status, exact changed files, commits, dependency changes, and diff,
- proxy-aware network destinations,
- persisted permissions and configured secret identifiers.

Agent-reported:

- semantic agent messages,
- internal child commands reported through vendor JSONL,
- tool and MCP calls/results reported by JSONL or `AGENTGUARD_EVENT`,
- planner and external reviewer structured output.

Inferred:

- policy violations,
- intent-comparison findings,
- deterministic test-presence conclusions,
- reviewer verdicts and risk-summary counts.

The API preserves these distinctions through `evidenceSource` and `verification`; reported MCP activity is never labeled independently verified.

### Known Limitations

- Existing Phase 1 sandbox and network limitations still apply: path policy is not kernel enforcement, direct sockets may bypass the proxy, filesystem reads are not traced, and HTTPS content is not inspected.
- JSON persistence and in-process asynchronous orchestration are not appropriate for multi-instance production deployment.
- Planner read-only access is declared and policy-checked but not kernel-enforced inside `/workspace`.
- A malicious resolver still executes code in the sandbox; path validation protects the deterministic resolver command but custom resolver behavior depends on runtime isolation.
- Approval is a human override and may coexist with unrelated open findings; the response exposes those findings rather than silently blocking or hiding them.
- Historical records created before Phase 2 do not retroactively gain intent or provenance fields.
- Retained workspaces can consume disk until lifecycle management is added.

### Next Priorities

1. Launch model-backed reviewers in dedicated read-only disposable VMs and validate their output through the existing reviewer interface.
2. Add durable background jobs/leases so review and resolution survive backend restarts.
3. Add workspace retention, archival, and garbage collection tied to approval/rejection policy.
4. Parse framework-specific test reports for counts, failures, and file coverage.
5. Add a generic MCP proxy that independently observes and enforces configured servers/tools.
6. Add production database migrations and indexed finding/review queries.
7. Add organization policy for whether approval is permitted with remaining open findings.
8. Add a controlled apply/merge workflow as a separate, explicitly authorized phase.
