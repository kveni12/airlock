"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowDown, Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { approveIntent, checkIntentAccess, createIntent, createRequest, createRun, generateIntent, getAgentProfiles, getIntentAlignment, rejectIntent, type IntentAlignmentResponse } from "@/lib/api";
import type { AccessGap, AccessGapReport, AgentIntent, AgentIntentDraft, AgentProfile, AgentProfileConfig, HumanRequest, RequestAnalysis, RuntimeProviderKind } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { AccessScopeEditor, DEFAULT_SCOPE, normalizeFolder, scopeToPermissions, summarizeScope, type AccessScope } from "./access-scope";
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

const shell = (value: string) => value.trim() ? ["/bin/sh", "-c", value.trim()] : undefined;

/** "script" = run an explicit shell command (demo scripts); otherwise a backend agent adapter kind. */
type AgentChoice = "script" | string;
const REAL_AGENT_TIMEOUT_MS = 20 * 60_000;
const SCRIPT_TIMEOUT_MS = 120_000;
const PICKABLE_KINDS = ["claude_code", "codex", "opencode", "cursor", "devin"];

export function NewRequestFlow() {
  const router = useRouter();
  const [taskId, setTaskId] = useState(`task-${Date.now().toString(36)}`);
  const [prompt, setPrompt] = useState("");
  const [requestResult, setRequestResult] = useState<{ request: HumanRequest; analysis: RequestAnalysis } | null>(null);

  const [intentMode, setIntentMode] = useState<"planner" | "manual">("manual");
  const [agentId, setAgentId] = useState("demo-planner");
  const [repoPath, setRepoPath] = useState("fixtures/intent-demo-repo");
  const [provider, setProvider] = useState<RuntimeProviderKind>("process");
  const [builderAgentId, setBuilderAgentId] = useState("demo-builder");
  const [builderCommand, setBuilderCommand] = useState("sh runtime/intent-demo-builder.sh");
  const [agentChoice, setAgentChoice] = useState<AgentChoice>("script");
  const [agentBinary, setAgentBinary] = useState("");
  const [scope, setScope] = useState<AccessScope>(DEFAULT_SCOPE);
  const [accessGaps, setAccessGaps] = useState<AccessGapReport | null>(null);
  const profiles = useResource<AgentProfile[]>((signal) => getAgentProfiles(signal), 60_000);
  const selectedProfile = profiles.data?.find((p) => p.kind === agentChoice);
  const usingRealAgent = agentChoice !== "script";
  const timeoutMs = usingRealAgent ? REAL_AGENT_TIMEOUT_MS : SCRIPT_TIMEOUT_MS;

  const chooseAgent = (choice: AgentChoice) => {
    setAgentChoice(choice);
    const profile = profiles.data?.find((p) => p.kind === choice);
    setScope((s) => ({ ...s, secrets: profile ? [...profile.recommendedSecrets] : [] }));
    if (choice !== "script") {
      setAgentId((id) => (id === "demo-planner" ? `${choice}-planner` : id));
      setBuilderAgentId((id) => (id === "demo-builder" ? `${choice}-builder` : id));
    }
  };

  const agentConfig = (prompt?: string): AgentProfileConfig | undefined =>
    usingRealAgent ? { kind: agentChoice, ...(agentBinary.trim() ? { binary: agentBinary.trim() } : {}), ...(prompt ? { prompt } : {}) } : undefined;
  const [plannerCommand, setPlannerCommand] = useState("sh runtime/intent-demo-planner.sh");
  const [intentJson, setIntentJson] = useState(JSON.stringify(DEMO_INTENT, null, 2));
  const [intent, setIntent] = useState<AgentIntent | null>(null);
  const [alignment, setAlignment] = useState<IntentAlignmentResponse | null>(null);

  const [error, setError] = useState<string | null>(null);

  const refreshAlignment = async (id: string) => setAlignment(await getIntentAlignment(id));

  useEffect(() => {
    if (!intent) { setAccessGaps(null); return; }
    let cancelled = false;
    checkIntentAccess(intent.id, scopeToPermissions(scope, "builder")).then((report) => { if (!cancelled) setAccessGaps(report); }).catch(() => { if (!cancelled) setAccessGaps(null); });
    return () => { cancelled = true; };
  }, [intent, scope]);

  const grant = (gap: AccessGap) => setScope((s) => {
    switch (gap.kind) {
      case "filesystem_write": {
        const isGlob = /\*/.test(gap.requested);
        const folder = isGlob ? gap.requested.replace(/\/?[^/]*\*.*$/, "") : gap.requested.replace(/\/?[^/]*$/, "");
        const path = normalizeFolder(folder || "/workspace");
        const folders = s.folders.some((f) => f.path === path) ? s.folders.map((f) => f.path === path ? { ...f, access: "read_write" as const } : f) : [...s.folders, { path, access: "read_write" as const }];
        return { ...s, folders };
      }
      case "network": return { ...s, hosts: [...s.hosts, gap.requested] };
      case "secret": return { ...s, secrets: [...s.secrets, gap.requested] };
      case "mcp_server": return { ...s, mcpServers: [...s.mcpServers, gap.requested] };
      case "tool": return { ...s, tools: [...s.tools, gap.requested] };
    }
  });

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
      created = await generateIntent({
        taskId,
        agentId,
        requestId: requestResult.request.id,
        repo: { path: repoPath },
        agent: agentConfig(),
        command: usingRealAgent ? undefined : shell(plannerCommand),
        permissions: scopeToPermissions(scope, "planner"),
        runtime: { provider },
        timeoutMs
      });
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
      agent: agentConfig(requestResult?.request.rawPrompt ?? prompt),
      command: usingRealAgent ? undefined : shell(builderCommand),
      runtime: { provider },
      requestId: requestResult?.request.id,
      intentId: intent.id,
      permissions: scopeToPermissions(scope, "builder"),
      timeoutMs
    });
    router.push(`/workbench/${runId}`);
  };

  const blocked = alignment?.executionBlockReason ?? null;

  const inputCls = "mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm";
  const labelCls = "text-xs font-semibold uppercase tracking-wider text-[#64717c]";
  const agentWorkspaceFields = <div className="space-y-3 rounded-xl border bg-[#f6f2ec] p-4">
    <p className="text-sm font-semibold">Agent &amp; workspace <span className="text-xs font-normal text-[#64717c]">(shared by planner and builder)</span></p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block text-sm"><span className={labelCls}>Agent</span>
        <select value={agentChoice} onChange={(e) => chooseAgent(e.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm">
          <option value="script">Shell command (demo scripts / custom)</option>
          {(profiles.data ?? []).filter((p) => PICKABLE_KINDS.includes(p.kind)).map((p) => <option key={p.kind} value={p.kind}>{p.displayName}</option>)}
        </select>
        {profiles.error && <span className="mt-1 block text-xs text-[#9a3d31]">Could not load agent profiles: {profiles.error}</span>}
      </label>
      <label className="block text-sm"><span className={labelCls}>Repo path (on the machine running the backend)</span><input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/you/code/my-app" className={inputCls} /></label>
      <label className="block text-sm"><span className={labelCls}>Runtime provider</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as RuntimeProviderKind)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm">
          <option value="process">process — no isolation, runs on this machine on a temp copy</option>
          <option value="lima">lima — disposable VM (macOS/Linux, needs npm run vm:setup)</option>
          <option value="docker">docker — container</option>
        </select>
      </label>
      {usingRealAgent && <label className="block text-sm"><span className={labelCls}>Agent binary (optional override)</span><input value={agentBinary} onChange={(e) => setAgentBinary(e.target.value)} placeholder={selectedProfile ? `default: ${agentChoice === "claude_code" ? "claude" : agentChoice === "cursor" ? "agent" : agentChoice}` : ""} className={inputCls} /></label>}
    </div>
    {agentChoice === "devin" && <p className="text-xs text-[#64717c]">Devin works in its own cloud VM, so Periscope cannot observe it directly. The bridge starts a Devin session via the API (needs <span className="mono">DEVIN_API_KEY</span>); the planner returns structured intent, the builder pushes its work to branch <span className="mono">agentguard/&lt;run id&gt;</span> of the repo&apos;s <span className="mono">origin</span> (Devin needs push access), which is then applied to the workspace and diffed. Devin&apos;s messages are agent-reported evidence.</p>}
    {usingRealAgent && selectedProfile && <p className="text-xs text-[#64717c]">{selectedProfile.description} {provider === "lima" && !selectedProfile.runtimeReady && <span className="text-[#9a3d31]">Lima base VM <span className="mono">{selectedProfile.defaultBaseVm}</span> not found — run <span className="mono">npm run vm:setup-agent -- {agentChoice}</span> or switch runtime.</span>}</p>}
    {provider === "process" && <p className="text-xs text-[#815017]">process runtime has no sandbox: the agent executes directly on the backend host against a temporary copy of the repo. Your original checkout is not mounted, but network, secrets and the rest of the machine are reachable.</p>}
  </div>;

  return <div className="mx-auto max-w-4xl space-y-3">
    <div className="mb-7"><p className="eyebrow">Pre-execution</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">New request</h1><p className="mt-2 max-w-2xl text-sm text-[#64717c]">Record the human request, capture the agent&apos;s declared intent before it can write anything, review the request → intent comparison, then start the execution sandbox.</p></div>
    {error && <ErrorBanner message={error} />}

    <Section eyebrow="Step 1" title="Human request" action={requestResult && <span className="status status-good"><Check className="mr-1 size-3.5" />recorded</span>}>
      <div className="space-y-3">
        <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Task id</span><input value={taskId} disabled={Boolean(requestResult)} onChange={(e) => setTaskId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f0f2f3]" /></label>
        <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Prompt (stored verbatim, immutable)</span><textarea value={prompt} disabled={Boolean(requestResult)} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Fix the login bug. Do not modify the database." className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f0f2f3]" /></label>
        {!requestResult && <div className="flex gap-2"><ActionButton disabled={!prompt.trim() || !taskId.trim()} onClick={async () => { try { await submitRequest(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Record request</ActionButton><ActionButton variant="secondary" onClick={() => setPrompt(DEMO_PROMPT)}>Use demo prompt</ActionButton></div>}
        {requestResult && <dl className="grid gap-3 rounded-xl border bg-[#f6f2ec] p-4 md:grid-cols-2">
          <KeyValue label="Objectives"><Chips items={requestResult.analysis.objectives.map((o) => o.text)} mono={false} /></KeyValue>
          <KeyValue label="Explicit constraints"><Chips items={requestResult.analysis.explicitConstraints.map((o) => o.text)} mono={false} /></KeyValue>
          <KeyValue label="Forbidden resources"><Chips items={requestResult.analysis.explicitlyForbiddenResources.map((r) => r.resource)} /></KeyValue>
          <KeyValue label="Inferred expectations"><Chips items={requestResult.analysis.inferredExpectations.map((o) => o.text)} mono={false} /></KeyValue>
          <p className="mono text-xs text-[#64717c] md:col-span-2">{requestResult.request.id} · analyzer: {requestResult.analysis.analyzer}</p>
        </dl>}
      </div>
    </Section>

    <div className="flex justify-center text-[#98a4ad]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 2" title="Agent intent (before execution)" action={intent && <AlignmentBadge status={alignment?.alignment?.status ?? intent.alignment?.status} large />}>
      {!requestResult ? <p className="text-sm text-[#64717c]">Record the request first.</p> : !intent ? <div className="space-y-3">
        <div className="flex gap-2">{(["manual", "planner"] as const).map((m) => <button key={m} onClick={() => setIntentMode(m)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intentMode === m ? "border-[#182a33] bg-[#182a33] text-white" : "bg-white text-[#64717c]"}`}>{m === "manual" ? "Paste structured intent" : "Run planner in read-only sandbox"}</button>)}</div>
        {agentWorkspaceFields}
        <AccessScopeEditor scope={scope} onChange={setScope} provider={provider} plannerOnly={intentMode === "planner"} />
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Planner agent id</span><input value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          {intentMode === "planner" && !usingRealAgent && <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Planner command</span><input value={plannerCommand} onChange={(e) => setPlannerCommand(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>}
        </div>
        {intentMode === "manual" && <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Structured intent JSON</span><textarea value={intentJson} onChange={(e) => setIntentJson(e.target.value)} rows={14} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-xs" /></label>}
        {intentMode === "planner" && <p className="text-xs text-[#64717c]">The planner runs in a read-only workspace copy. {usingRealAgent ? <>Periscope prepends instructions so {selectedProfile?.displayName ?? agentChoice} answers with the structured intent as JSON; the human request is passed verbatim.</> : <>The command must print an <span className="mono">AGENTGUARD_EVENT</span> intent line.</>} Any write attempt fails the planning run.</p>}
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
        <div className="rounded-xl border bg-[#f6f2ec] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Does the plan fit the access scope?</p>{accessGaps && (accessGaps.gaps.length ? <span className="status status-warn"><ShieldAlert className="mr-1 size-3.5" />{accessGaps.gaps.length} more access needed</span> : <span className="status status-good"><ShieldCheck className="mr-1 size-3.5" />fits</span>)}</div>
          {!accessGaps && <p className="mt-2 text-sm text-[#64717c]">Checking…</p>}
          {accessGaps && accessGaps.gaps.length === 0 && <p className="mt-2 text-sm text-[#64717c]">Everything the agent says it needs is already allowed. Nothing extra is granted.</p>}
          {accessGaps && accessGaps.gaps.length > 0 && <>
            <p className="mt-2 text-xs text-[#64717c]">These come from the agent&apos;s own plan (agent-reported). Grant only what you agree with — anything you leave denied is {""}<em>blocked</em> (network, secrets) or <em>flagged</em> in the workbench if the agent tries anyway.</p>
            <ul className="mt-3 space-y-2">{accessGaps.gaps.map((gap) => <li key={`${gap.kind}:${gap.requested}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-sm">
              <span><span className="mono font-semibold">{gap.requested}</span> <span className="text-[#64717c]">— {gap.reason}</span> <span className={`status ${gap.enforcement === "blocked" ? "status-good" : gap.enforcement === "flagged" ? "status-warn" : "status-muted"}`}>{gap.enforcement === "blocked" ? "blocked if denied" : gap.enforcement === "flagged" ? "flagged if attempted" : "agent-reported only"}</span></span>
              <ActionButton variant="secondary" onClick={() => grant(gap)}>Grant</ActionButton>
            </li>)}</ul>
          </>}
        </div>
        <div className="rounded-xl border bg-[#f6f2ec] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Request → Intent comparison</p><AlignmentBadge status={alignment?.alignment?.status} /></div>
          {alignment && alignment.findings.length === 0 && <p className="mt-2 text-sm text-[#64717c]">No pre-execution findings. The declared intent does not contradict any explicit constraint or miss a requested objective.</p>}
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

    <div className="flex justify-center text-[#98a4ad]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 3" title="Execution sandbox">
      {!intent ? <p className="text-sm text-[#64717c]">Capture intent first — Periscope will not start a builder without a declared intent to compare against.</p> : <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Builder agent id</span><input value={builderAgentId} onChange={(e) => setBuilderAgentId(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>
          {usingRealAgent ? <p className="text-sm text-[#64717c] md:self-end">{selectedProfile?.displayName ?? agentChoice} runs in <span className="mono">{repoPath}</span> ({provider}) with the recorded prompt.</p> : <label className="block text-sm"><span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">Builder command</span><input value={builderCommand} onChange={(e) => setBuilderCommand(e.target.value)} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm" /></label>}
        </div>
        <div className="rounded-xl border bg-[#f6f2ec] p-4">
          <p className="text-sm font-semibold">The run will start with exactly this access</p>
          <ul className="mt-2 space-y-0.5 text-sm">{summarizeScope(scope, provider).map((line) => <li key={line}>{line}</li>)}</ul>
          {accessGaps && accessGaps.gaps.length > 0 && <p className="mt-2 text-xs text-[#815017]">{accessGaps.gaps.length} item{accessGaps.gaps.length === 1 ? "" : "s"} from the plan {accessGaps.gaps.length === 1 ? "is" : "are"} still denied — that is fine if intentional; attempts will show up as out-of-scope in the workbench.</p>}
          <details className="mt-2 text-sm"><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-[#64717c]">Adjust scope</summary><div className="mt-2"><AccessScopeEditor scope={scope} onChange={setScope} provider={provider} /></div></details>
        </div>
        {blocked && <p className="text-sm text-[#9a3d31]">{blocked}</p>}
        <ActionButton disabled={Boolean(blocked)} onClick={async () => { try { await startRun(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Start execution run</ActionButton>
      </div>}
    </Section>
  </div>;
}
