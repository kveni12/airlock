# AgentGuard Intent Observability Specification

## Objective

AgentGuard must answer five distinct questions for every coding-agent run and keep the answers separate:

1. What did the **human** ask the agent to do?
2. What did the **agent** say it intended to do?
3. What was the agent **allowed** to access?
4. What did AgentGuard **observe** the agent actually doing?
5. What **result** did the agent produce?

The intended chain is:

```text
REQUEST -> INTENT -> PERMISSIONS -> OBSERVED BEHAVIOR -> RESULT
```

Comparing adjacent links exposes two drift classes:

- **Request -> Intent drift**: the agent's plan exceeds, contradicts, or misses the human request. Detected *before* execution.
- **Intent -> Behavior drift**: the agent does something other than what it declared. Detected from independently observed telemetry *after/during* execution.

The layer must never claim that AgentGuard observed something when the evidence is only agent-reported or inferred, and must never claim absence of behavior when the relevant telemetry channel is unavailable.

## Existing Components Being Reused

| Concern | Existing component | Reuse |
| --- | --- | --- |
| Sandboxed execution | `RuntimeManager`, `LimaProvider`, `DockerProvider` | Unchanged lifecycle; planner runs gain a read-only mount |
| Agent adapters | `src/agents/agentAdapter.ts` | Planner and builder commands are built by the same adapters |
| Event pipeline | `EventCollector`, `JsonStore`, SSE stream | All new lifecycle events (`human.request`, `intent.*`) go through the collector |
| Evidence provenance | `EvidenceSource`, `EvidenceVerification` on `AgentEvent` | Copied onto finding evidence and timeline entries |
| Structured intent | `AgentIntent`, `IntentService`, `/api/intents/generate` | Extended with new fields, request linkage, alignment and approval state |
| Behavior comparison | `BehaviorAnalyzer`, `BehaviorAnalysisService` | Wrapped by `IntentBehaviorAnalyzer`; existing checks are not rewritten |
| Findings | `Finding`, `FindingService` | One new `FindingSource` (`request_intent_comparison`), one new `FindingType` (`missing_action`) |
| Policy | `PolicyEngine` | Untouched; policy findings are surfaced in alignment counts |
| Review / resolution / approval | `ReviewService`, `ResolutionService`, `POST /api/reviews/:id/approve` | Untouched; consumed by the result summary and timeline |
| Dashboard | `SummaryService` | Complemented by a new composed read model, not duplicated |
| Demo | `scripts/run-phase2-demo.sh`, `runtime/phase2-demo-agent.sh` | New `demo:intent` follows the same shape and the same real pipeline |

## Proposed Architecture

```text
POST /api/requests  (rawPrompt)            POST /api/intents/generate {requestId}
        |                                             |
   RequestService                              planner run (read-only workspace)
        |                                             |
   RequestAnalyzer  ---- RequestAnalysis         IntentService.validate
        |                                             |
        +------------------ RequestIntentAnalyzer ----+
                                   |
                     intent.alignment = aligned | warning | conflict
                     request_intent_comparison findings (pre-execution)
                                   |
                  conflict -> approval required (POST /api/intents/:id/approve|reject|revise)
                                   |
                            POST /api/runs {intentId}   (execution sandbox)
                                   |
                  existing telemetry -> IntentBehaviorAnalyzer -> intent_comparison findings
                                   |
                  ReviewService -> ResolutionService -> re-review -> approval (existing)
                                   |
        AlignmentService: /alignment, /timeline, /behavior, /result, /detail (composed read models)
```

New modules:

- `src/request/requestAnalyzer.ts` – deterministic prompt analysis.
- `src/request/requestService.ts` – persistence of immutable `HumanRequest` plus `RequestAnalysis`.
- `src/analysis/requestIntentAnalyzer.ts` – request <-> intent comparison.
- `src/analysis/intentBehaviorAnalyzer.ts` – intent <-> behavior comparison, behavior summary enrichment, telemetry coverage.
- `src/dashboard/alignmentService.ts` – alignment summary, result summary, timeline, run detail.

## Models Being Added / Changed

### HumanRequest (new)

```ts
interface HumanRequest {
  id: string;
  taskId: string;
  runId?: string;              // attached when a builder run is created
  rawPrompt: string;           // immutable; source of truth
  explicitConstraints?: string[];   // caller-supplied, treated as explicit
  requestedObjectives?: string[];   // caller-supplied, treated as explicit
  context?: { attachments?: string[]; metadata?: Record<string, unknown> };
  createdAt: string;
}
```

`runId` is optional because the request exists before any run does. The store exposes no method that mutates `rawPrompt`; `attachToRun` is the only update.

### RequestAnalysis (new)

```ts
type RequestProvenance = "explicit" | "inferred";
interface RequestStatement { text: string; provenance: RequestProvenance; source: "prompt" | "caller" | "analyzer"; excerpt?: string }
interface RequestResource { resource: string; category: "database" | "infrastructure" | "dependencies" | "network" | "secrets" | "tests" | "configuration" | "other"; provenance: RequestProvenance; excerpt: string }

interface RequestAnalysis {
  id: string;
  requestId: string;
  objectives: RequestStatement[];           // explicit
  explicitConstraints: RequestStatement[];  // explicit
  inferredExpectations: RequestStatement[]; // inferred, never used for blocking
  explicitlyRequestedResources: RequestResource[];
  explicitlyForbiddenResources: RequestResource[];
  ambiguities: string[];
  analyzer: "deterministic";
  createdAt: string;
}
```

### AgentIntent (extended, backward compatible)

Added optional draft fields; required (defaulted) on persisted intents:

```ts
interpretation: string;        // defaults to summary
plannedActions: string[];      // alias of plannedChanges; both persisted with the same content
expectedCommands: string[];
expectedTools: string[];
assumptions: string[];
```

Added linkage/lifecycle fields:

```ts
requestId?: string;
planningRunId?: string;
alignment?: { status: "aligned" | "warning" | "conflict"; findingIds: string[]; analyzedAt: string };
approval?: { status: "approved" | "rejected"; actor?: string; reason?: string; at: string };
supersededBy?: string;
```

Old stored intents lacking the new arrays are normalized on read.

### Finding (extended)

```ts
type FindingSource = "policy" | "intent_comparison" | "request_intent_comparison" | "reviewer";
type FindingType = ... | "missing_action";
interface Finding { runId?: string; ... }   // pre-execution findings have no run yet
interface FindingEvidence {
  eventIds?; diffSnippet?; observedResource?; declaredResource?;
  requestId?: string; intentId?: string;
  humanRequestExcerpt?: string; agentIntentExcerpt?: string;
  verification?: EvidenceVerification;    // strongest evidence backing the finding
}
```

`runId` becomes optional only so request/intent findings can exist before execution; `FindingService.attachToRun(intentId, runId)` fills it in when the builder run starts.

### BehaviorSummary (extended)

```ts
filesCreated / filesDeleted: Array<{ resource; eventIds }>   // filesystem evidence
filesRead: "unavailable";
tools: Array<{ resource; eventIds; verification }>;
coverage: TelemetryCoverage;
```

```ts
interface TelemetryCoverage {
  filesystemWrites: "independent"; filesystemReads: "unavailable";
  networkProxyTraffic: "independent"; directSocketTraffic: "unavailable";
  gitChanges: "independent"; processCommands: "independent" | "agent_reported";
  agentToolCalls: "agent_reported"; mcpCalls: "agent_reported"; secretAccess: "agent_reported";
}
```

### AlignmentSummary, ResultSummary, TimelineEntry (new, derived, not persisted)

As requested by the product brief; no numerical trust score. `TimelineEntry` = `{ id, timestamp, kind, actor: "human" | "agent" | "agentguard" | "runtime", title, detail?, refs: { eventId?, findingId?, requestId?, intentId?, reviewId?, resolutionId? }, evidenceSource?, verification? }`.

### RunRecord

Adds `requestId?` and `workspaceAccess?: "read_only" | "read_write"`.

### StoredData

Adds `requests: HumanRequest[]` and `requestAnalyses: RequestAnalysis[]`; `emptyStoredData()` and load normalization default them.

## APIs Being Added / Changed

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/requests` | Create immutable human request; runs `RequestAnalyzer`; returns request + analysis |
| GET | `/api/requests/:id` | Raw request |
| GET | `/api/requests/:id/analysis` | Structured analysis |
| POST | `/api/intents` (changed) | Accepts `requestId`; runs request <-> intent analysis; returns intent with `alignment` and findings |
| POST | `/api/intents/generate` (changed) | Accepts `requestId` (prompt comes from the raw request); planner sandbox is read-only; analysis runs on the generated intent |
| GET | `/api/intents/:id/alignment` | Pre-execution decision + findings |
| POST | `/api/intents/:id/approve` | Human approves a `conflict`/`warning` intent |
| POST | `/api/intents/:id/reject` | Human cancels; blocks run creation with this intent |
| POST | `/api/intents/:id/revise` | Creates a superseding intent from an edited draft, re-analyzed |
| POST | `/api/runs` (changed) | Accepts `requestId`; rejects (409) an intent in `conflict` without approval or one that was rejected/superseded |
| GET | `/api/runs/:id/request` | Request attached to run |
| GET | `/api/runs/:id/alignment` | `AlignmentSummary` with finding/evidence references |
| GET | `/api/runs/:id/behavior` | Compact behavior summary with coverage |
| GET | `/api/runs/:id/result` | Normalized result summary |
| GET | `/api/runs/:id/timeline` | Chronological normalized entries |
| GET | `/api/runs/:id/detail` | Composed read model `{request, requestAnalysis, intent, permissions, behaviorSummary, result, alignment, findings, review}` |

## Request -> Intent Analysis Design

### RequestAnalyzer (deterministic)

1. Split the prompt into sentences.
2. A sentence is an **explicit constraint** when it matches a negation/prohibition pattern (`do not`, `don't`, `never`, `must not`, `should not`, `avoid`, `without …ing`, `only …`). Everything else that is imperative is an **explicit objective**. Compound objectives joined by `and` are split when both halves start with a verb.
3. **Forbidden resources** are extracted from constraint sentences with a small lexicon (database/db/table/schema/migration; infrastructure/infra/terraform/deploy/kubernetes/docker; dependency/dependencies/package/library; network/external service/api call; secret/credential/token; test; config/configuration). **Requested resources** come from objectives the same way.
4. **Inferred expectations** are produced from objectives only (e.g. "add a regression test" -> "tests are expected to run"), tagged `inferred`, and never used to generate blocking findings.
5. **Ambiguities**: hedging words (`maybe`, `if necessary`, `as needed`, `etc`, `or`), pronoun-only objectives, and prompts with zero objectives.
6. Caller-supplied `explicitConstraints`/`requestedObjectives` are merged as explicit with `source: "caller"`.

Absence of a mention is never converted into a prohibition.

### RequestIntentAnalyzer (deterministic; conservative)

Inputs: `HumanRequest`, `RequestAnalysis`, `AgentIntent`. Output: `{ status, findings: FindingDraft[] }`.

| Check | Trigger | Severity / status | Verification |
| --- | --- | --- | --- |
| Explicit constraint violation | An `explicitlyForbiddenResources` category is matched (lexicon) in `plannedActions`, `interpretation`, `expectedFiles`, or by non-empty `expectedDependencies` / `expectedNetwork` for the `dependencies` / `network` categories | `high` -> `conflict` (blocks) | `independent` (both texts are on record) |
| Missing requested objective | Content-word overlap between an explicit objective and `goal + interpretation + plannedActions + expectedFiles` is below threshold | `medium` -> `warning` | `inferred` |
| Scope expansion | A planned action contains a broadening verb (`refactor`, `rewrite`, `migrate`, `replace`, `redesign`, `upgrade`, `rename across`) and shares no content words with the request | `medium` -> `warning` | `inferred` |
| Constraint not acknowledged | Explicit request constraint has no counterpart in `intent.constraints` | `low` -> `warning` | `inferred` |
| Contradictory interpretation | Interpretation asserts a forbidden resource will change (covered by check 1 applied to `interpretation`) | `high` -> `conflict` | `independent` |

Status: `conflict` if any high/critical finding, `warning` if any other, else `aligned`. No LLM is consulted; semantic judgments beyond the lexicon are explicitly out of scope and recorded as a limitation.

## Intent -> Behavior Analysis Design

`IntentBehaviorAnalyzer` wraps the existing `BehaviorAnalyzer` (which already yields unexpected file / dependency / network / secret / MCP-server findings and missing-test findings) and adds:

| Check | Evidence | Severity | Verification |
| --- | --- | --- | --- |
| Unexpected command | `process.command_start` outside `expectedCommands` (prefix match) when `expectedCommands` is non-empty | `low` | event's own verification (`independent` for runtime-spawned, `agent_reported` for JSONL) |
| Unexpected tool | `agent.tool_call` / `mcp.tool_call` names outside `expectedTools` when declared | `low` | `agent_reported` |
| Expected file not modified | Declared concrete path (no glob) absent from Git changed files | `info` | `inferred` |
| Expected command not observed | Declared command with no matching `process.*` evidence | `medium` if it is a test command, else `info` | `inferred` |
| Expected MCP server not observed | Already exists in `BehaviorAnalyzer` (`info`) | – | `inferred` |

Every finding sets `evidence.verification` to the strongest backing evidence and `evidence.intentId`/`requestId`. Absence-of-evidence findings are only emitted when the relevant coverage channel is not `unavailable`.

## Evidence / Provenance Design

- Events keep their existing `evidenceSource` / `verification`.
- Findings gain `evidence.verification` derived from their event IDs; pre-execution findings carry excerpts of both the raw request and the intent item.
- The behavior summary carries `coverage`, so any "not observed" claim can be checked against whether the channel exists.
- Timeline entries copy provenance from their source event/finding.
- Correlation chain: `HumanRequest.id` -> `AgentIntent.requestId` -> `Finding.evidence.{requestId,intentId,eventIds}` -> `GitSummary.files` -> `Review.findingIds`. IDs only; payloads are not duplicated.

## Pre-Execution Lifecycle

1. `POST /api/requests` persists the raw prompt and analysis; emits `human.request` (category `runtime`, action `human_request` in the existing event schema is avoided: a dedicated `EventCategory` value `governance` is added for `human_request`, `request_analyzed`, `intent_declared`, `intent_analyzed`, `intent_approved`, `intent_rejected`, `intent_revised`).
2. `POST /api/intents/generate {requestId}` starts a **planner** run:
   - `purpose: "planner"`, `workspaceAccess: "read_only"`.
   - Enforcement: the sandbox mount itself is read-only – Lima `--mount-only <path>` (no `:w`), Docker bind `<path>:/workspace:ro`. Permission snapshot is also `read` only so policy violations fire on any write attempt that reaches the host copy. After the run, `git status --porcelain` on the host copy must be empty; otherwise `runtime.planning_workspace_modified` is emitted and the intent is rejected.
   - Output must contain exactly one `agent.intent` event; malformed or missing output emits `runtime.intent_generation_failed` and returns 422. No empty intent is substituted.
3. `IntentService.validate` normalizes and validates the draft (existing rules + new arrays).
4. `RequestIntentAnalyzer` runs; findings are created through `FindingService` with `source: "request_intent_comparison"` and no `runId`; `intent.alignment` is stored.
5. Decision:
   - `aligned` -> run may start.
   - `warning` -> run may start; findings stay open for review.
   - `conflict` -> `POST /api/runs` returns 409 until `POST /api/intents/:id/approve` (or a revised intent is aligned). `reject` cancels; `revise` supersedes.
6. `POST /api/runs {intentId, requestId}` attaches request/intent/findings to the builder run and proceeds through the existing runtime lifecycle.

## Failure Behavior

- Empty/whitespace `rawPrompt` -> 400; nothing persisted.
- Planner failure/timeout -> existing run failure path plus `runtime.intent_generation_failed`; no intent created.
- Planner workspace modified -> `runtime.planning_workspace_modified` (severity high); intent discarded.
- Malformed intent -> 422 with validation message; event `runtime.intent_generation_failed`.
- Request/intent analysis exception -> `runtime.analysis_failed` event; intent stored without `alignment`; run creation refused (409) because the decision is unknown.
- Behavior analysis exception -> existing `runtime.analysis_failed` path.
- Read-model endpoints degrade field by field (`null` for missing request/intent/review) rather than failing the whole response.

## Files Expected to Change

New:

- `src/request/requestAnalyzer.ts`, `src/request/requestService.ts`
- `src/analysis/requestIntentAnalyzer.ts`, `src/analysis/intentBehaviorAnalyzer.ts`
- `src/dashboard/alignmentService.ts`
- `scripts/run-intent-demo.sh`, `runtime/intent-demo-agent.sh`, `fixtures/intent-demo-repo/**`
- `tests/requestAnalyzer.test.ts`, `tests/requestService.test.ts`, `tests/requestIntentAnalyzer.test.ts`, `tests/intentBehaviorAnalyzer.test.ts`, `tests/alignmentService.test.ts`, `tests/intentObservability.e2e.test.ts`, `tests/intent.integration.test.ts`

Modified:

- `src/types.ts`, `src/store/jsonStore.ts`, `src/intent/intentService.ts`, `src/findings/findingService.ts`, `src/analysis/behaviorAnalyzer.ts` (summary enrichment only), `src/runtime/runtimeManager.ts`, `src/runtime/limaProvider.ts`, `src/runtime/dockerProvider.ts`, `src/runtime/sandboxProvider.ts`, `src/events/eventCollector.ts` (provenance for `governance` category), `src/app.ts`, `runtime/Dockerfile`, `scripts/setup-vm-runtime.sh`, `package.json`, `README.md`

## Explicit Non-Goals

- Replacing Lima or rewriting the Docker runtime.
- PostgreSQL migration.
- Kernel-level filesystem read tracing, eBPF, HTTPS interception, direct-socket enforcement.
- Kubernetes, production auth, billing, UI implementation.
- Generic MCP proxy rewrite.
- LLM-based semantic request/intent comparison (deterministic only in this phase).
- Merging approved results into the developer checkout.
- Any numerical trust/risk score.
