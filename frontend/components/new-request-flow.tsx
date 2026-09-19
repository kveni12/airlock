"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowDown, Check } from "lucide-react";
import { approveIntent, createIntent, createRequest, createRun, generateIntent, getIntentAlignment, rejectIntent, type IntentAlignmentResponse } from "@/lib/api";
import type { AgentIntent, AgentIntentDraft, HumanRequest, RequestAnalysis, RuntimeProviderKind } from "@/lib/contracts";
import { FindingCard } from "./finding-card";
import { ActionButton, AlignmentBadge, Chips, ErrorBanner, KeyValue, Section } from "./ui";

const DEMO_PROMPT = "Fix the login/session bug and add a regression test.\nDo not modify database or infrastructure configuration.\nDo not add external dependencies.";
const DEMO_INTENT: AgentIntentDraft = {
  goal: "Fix login failures caused by expired sessions",
  interpretation: "Investigate the session flow and correct the bug without touching database or infrastructure configuration.",
  plannedActions: ["Inspect session handling", "Modify session.ts", "Add session regression test", "Run authentication tests"],
  expectedFiles: ["src/auth/session.ts", "tests/auth/session.test.ts"],
  expectedDependencies: [],
  expectedCommands: ["npm test"],
  expectedNetwork: [],
  expectedSecrets: [],
  expectedMcpServers: [],
  expectedTools: ["filesystem", "shell"],
  constraints: ["Do not modify database or infrastructure configuration", "Do not add external dependencies"]
};

const lines = (value: string) => value.split("\n").map((l) => l.trim()).filter(Boolean);
const shell = (value: string) => value.trim() ? ["/bin/sh", "-c", value.trim()] : undefined;

export function NewRequestFlow() {
  const router = useRouter();
  const [taskId, setTaskId] = useState(`task-${Date.now().toString(36)}`);
  const [prompt, setPrompt] = useState("");
  const [requestResult, setRequestResult] = useState<{ request: HumanRequest; analysis: RequestAnalysis } | null>(null);

  const [intentMode, setIntentMode] = useState<"planner" | "manual">("manual");
  const [agentId, setAgentId] = useState("demo-planner");
  const [repoPath, setRepoPath] = useState("fixtures/intent-demo-repo");
  const [provider, setProvider] = useState<RuntimeProviderKind>("process");
  const [plannerCommand, setPlannerCommand] = useState("sh runtime/intent-demo-planner.sh");
  const [intentJson, setIntentJson] = useState(JSON.stringify(DEMO_INTENT, null, 2));
  const [intent, setIntent] = useState<AgentIntent | null>(null);
  const [alignment, setAlignment] = useState<IntentAlignmentResponse | null>(null);

  const [builderAgentId, setBuilderAgentId] = useState("demo-builder");
  const [builderCommand, setBuilderCommand] = useState("sh runtime/intent-demo-builder.sh");
  const [fsAccess, setFsAccess] = useState<"read" | "read_write">("read_write");
  const [network, setNetwork] = useState("");
  const [tools, setTools] = useState("filesystem\nshell");
  const [error, setError] = useState<string | null>(null);

  const refreshAlignment = async (id: string) => setAlignment(await getIntentAlignment(id));

  const submitRequest = async () => {
    setError(null);
    const result = await createRequest({ taskId, rawPrompt: prompt });
    setRequestResult(result);
    setIntent(null);
    setAlignment(null);
  };

  const submitIntent = async () => {
    if (!requestResult) return;
    setError(null);
    let created: AgentIntent;
    if (intentMode === "planner") {
      created = await generateIntent({ taskId, agentId, requestId: requestResult.request.id, repo: { path: repoPath }, command: shell(plannerCommand), runtime: { provider }, timeoutMs: 120_000 });
    } else {
      const draft = JSON.parse(intentJson) as AgentIntentDraft;
      created = await createIntent({ ...draft, taskId, agentId, agentType: "human", requestId: requestResult.request.id });
    }
    setIntent(created);
    await refreshAlignment(created.id);
  };

  const startRun = async () => {
    if (!intent) return;
    setError(null);
    const { runId } = await createRun({
      taskId,
      agentId: builderAgentId,
      repo: { path: repoPath },
      command: shell(builderCommand),
      runtime: { provider },
      requestId: requestResult?.request.id,
      intentId: intent.id,
      permissions: { filesystem: [{ path: "/workspace", access: fsAccess }], network: lines(network), secrets: [], mcpServers: [], tools: lines(tools) },
      timeoutMs: 120_000
    });
    router.push(`/runs/${runId}`);
  };

  const blocked = alignment?.executionBlockReason ?? null;

  return <div className="mx-auto max-w-4xl space-y-3">
    <div className="mb-7"><p className="eyebrow">Pre-execution</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">New request</h1><p className="mt-2 max-w-2xl text-sm text-[#657068]">Record the human request, capture the agent&apos;s declared intent before it can write anything, review the request → intent comparison, then start the execution sandbox.</p></div>
    {error && <ErrorBanner message={error} />}

    <Section eyebrow="Step 1" title="Human request" action={requestResult && <span className="status status-good"><Check className="mr-1 size-3.5" />recorded</span>}>
      <div className="space-y-3">
        <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Task id</span><input value={taskId} disabled={Boolean(requestResult)} onChange={(e) => setTaskId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f1f4ee]" /></label>
        <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Prompt (stored verbatim, immutable)</span><textarea value={prompt} disabled={Boolean(requestResult)} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Fix the login bug. Do not modify the database." className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f1f4ee]" /></label>
        {!requestResult && <div className="flex gap-2"><ActionButton disabled={!prompt.trim() || !taskId.trim()} onClick={async () => { try { await submitRequest(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Record request</ActionButton><ActionButton variant="secondary" onClick={() => setPrompt(DEMO_PROMPT)}>Use demo prompt</ActionButton></div>}
        {requestResult && <dl className="grid gap-3 rounded-xl border bg-[#f7f9f4] p-4 md:grid-cols-2">
          <KeyValue label="Objectives"><Chips items={requestResult.analysis.objectives.map((o) => o.text)} mono={false} /></KeyValue>
          <KeyValue label="Explicit constraints"><Chips items={requestResult.analysis.explicitConstraints.map((o) => o.text)} mono={false} /></KeyValue>
          <KeyValue label="Forbidden resources"><Chips items={requestResult.analysis.explicitlyForbiddenResources.map((r) => r.resource)} /></KeyValue>
          <KeyValue label="Inferred expectations"><Chips items={requestResult.analysis.inferredExpectations.map((o) => o.text)} mono={false} /></KeyValue>
          <p className="mono text-xs text-[#657068] md:col-span-2">{requestResult.request.id} · analyzer: {requestResult.analysis.analyzer}</p>
        </dl>}
      </div>
    </Section>

    <div className="flex justify-center text-[#9ca99d]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 2" title="Agent intent (before execution)" action={intent && <AlignmentBadge status={alignment?.alignment?.status ?? intent.alignment?.status} large />}>
      {!requestResult ? <p className="text-sm text-[#657068]">Record the request first.</p> : !intent ? <div className="space-y-3">
        <div className="flex gap-2">{(["manual", "planner"] as const).map((m) => <button key={m} onClick={() => setIntentMode(m)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intentMode === m ? "border-[#101913] bg-[#101913] text-white" : "bg-white text-[#657068]"}`}>{m === "manual" ? "Paste structured intent" : "Run planner in read-only sandbox"}</button>)}</div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Agent id</span><input value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Repo path (on backend host)</span><input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Runtime provider</span><select value={provider} onChange={(e) => setProvider(e.target.value as RuntimeProviderKind)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"><option value="process">process (unsandboxed, local demo only)</option><option value="lima">lima</option><option value="docker">docker</option></select></label>
          {intentMode === "planner" && <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Planner command</span><input value={plannerCommand} onChange={(e) => setPlannerCommand(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>}
        </div>
        {intentMode === "manual" && <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Structured intent JSON</span><textarea value={intentJson} onChange={(e) => setIntentJson(e.target.value)} rows={14} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-xs" /></label>}
        {intentMode === "planner" && <p className="text-xs text-[#657068]">The planner runs in a read-only workspace copy and must print an <span className="mono">AGENTGUARD_EVENT</span> intent line; any write attempt fails the planning run.</p>}
        <ActionButton onClick={async () => { try { await submitIntent(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>{intentMode === "planner" ? "Run planner & capture intent" : "Submit intent & analyze"}</ActionButton>
      </div> : <div className="space-y-4">
        <dl className="space-y-3">
          <KeyValue label="Goal">{intent.goal}</KeyValue>
          <KeyValue label="Planned actions"><ol className="list-decimal space-y-1 pl-5 text-sm">{intent.plannedChanges.map((a, i) => <li key={i}>{a}</li>)}</ol></KeyValue>
          <KeyValue label="Expected files"><Chips items={intent.expectedFiles} /></KeyValue>
          <KeyValue label="Expected deps / network"><Chips items={[...intent.expectedDependencies, ...intent.expectedNetwork]} /></KeyValue>
          <KeyValue label="Constraints"><Chips items={intent.constraints} mono={false} /></KeyValue>
          {intent.planningRunId && <KeyValue label="Planning run"><Link className="underline" href={`/runs/${intent.planningRunId}`}>{intent.planningRunId}</Link> (read-only workspace)</KeyValue>}
        </dl>
        <div className="rounded-xl border bg-[#f7f9f4] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Request → Intent comparison</p><AlignmentBadge status={alignment?.alignment?.status} /></div>
          {alignment && alignment.findings.length === 0 && <p className="mt-2 text-sm text-[#657068]">No pre-execution findings. The declared intent does not contradict any explicit constraint or miss a requested objective.</p>}
          <div className="mt-3 grid gap-3">{alignment?.findings.map((f) => <FindingCard key={f.id} finding={f} onChanged={() => refreshAlignment(intent.id)} />)}</div>
          {blocked && <p className="mt-3 text-sm text-[#9a3d31]">Execution blocked: {blocked}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {alignment?.approval ? <span className={`status ${alignment.approval.status === "approved" ? "status-good" : "status-bad"}`}>{alignment.approval.status}{alignment.approval.actor && ` by ${alignment.approval.actor}`}</span> : <>
            <ActionButton onClick={async () => { await approveIntent(intent.id, { actor: "human", reason: "Approved from new-request flow" }); await refreshAlignment(intent.id); }}>Approve intent</ActionButton>
            <ActionButton variant="danger" onClick={async () => { await rejectIntent(intent.id, { actor: "human", reason: "Rejected from new-request flow" }); await refreshAlignment(intent.id); }}>Reject intent</ActionButton>
          </>}
          <ActionButton variant="secondary" onClick={() => { setIntent(null); setAlignment(null); }}>Retry with a different intent</ActionButton>
        </div>
      </div>}
    </Section>

    <div className="flex justify-center text-[#9ca99d]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 3" title="Execution sandbox">
      {!intent ? <p className="text-sm text-[#657068]">Capture intent first — AgentGuard will not start a builder without a declared intent to compare against.</p> : <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Builder agent id</span><input value={builderAgentId} onChange={(e) => setBuilderAgentId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Builder command</span><input value={builderCommand} onChange={(e) => setBuilderCommand(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Workspace access</span><select value={fsAccess} onChange={(e) => setFsAccess(e.target.value as "read" | "read_write")} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"><option value="read_write">/workspace read + write</option><option value="read">/workspace read only</option></select></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Network allowlist (one host per line)</span><textarea value={network} onChange={(e) => setNetwork(e.target.value)} rows={2} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#657068]">Tools (one per line)</span><textarea value={tools} onChange={(e) => setTools(e.target.value)} rows={2} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
        </div>
        {blocked && <p className="text-sm text-[#9a3d31]">{blocked}</p>}
        <ActionButton disabled={Boolean(blocked)} onClick={async () => { try { await startRun(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Start execution run</ActionButton>
      </div>}
    </Section>
  </div>;
}
