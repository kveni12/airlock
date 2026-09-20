"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, Check, Plus, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { approveIntent, checkIntentAccess, createIntent, createRequest, createRun, generateIntent, getAgentProfiles, getIntentAlignment, previewRequest, rejectIntent, type IntentAlignmentResponse } from "@/lib/api";
import type { AccessGap, AccessGapReport, AgentIntent, AgentIntentDraft, AgentProfile, AgentProfileConfig, HumanRequest, RequestAnalysis, RuntimeProviderKind } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { AccessScopeEditor, DEFAULT_SCOPE, scopeToPermissions, setFolderAccess, summarizeScope, type AccessScope } from "./access-scope";
import { FindingCard } from "./finding-card";
import { RuntimeStatusPanel } from "./runtime-status";
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
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<RequestAnalysis | null>(null);
  const [objectives, setObjectives] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<string[]>([]);
  const [requestResult, setRequestResult] = useState<{ request: HumanRequest; analysis: RequestAnalysis } | null>(null);

  const [intentMode, setIntentMode] = useState<"planner" | "manual">("planner");
  const [agentId, setAgentId] = useState("demo-planner");
  const [repoPath, setRepoPath] = useState("fixtures/intent-demo-repo");
  const [provider, setProvider] = useState<RuntimeProviderKind>("docker");
  const [builderAgentId, setBuilderAgentId] = useState("demo-builder");
  const [builderCommand, setBuilderCommand] = useState("agentguard-intent-demo-builder");
  const [agentChoice, setAgentChoice] = useState<AgentChoice>("script");
  const [agentBinary, setAgentBinary] = useState("");
  const [scope, setScope] = useState<AccessScope>(DEFAULT_SCOPE);
  const [accessGaps, setAccessGaps] = useState<AccessGapReport | null>(null);
  const loadAgentProfiles = useCallback((signal: AbortSignal) => getAgentProfiles(signal), []);
  const profiles = useResource<AgentProfile[]>(loadAgentProfiles, 60_000);
  const selectedProfile = profiles.data?.find((p) => p.kind === agentChoice);
  const usingRealAgent = agentChoice !== "script";
  const timeoutMs = usingRealAgent ? REAL_AGENT_TIMEOUT_MS : SCRIPT_TIMEOUT_MS;

  const chooseAgent = (choice: AgentChoice) => {
    setAgentChoice(choice);
    const profile = profiles.data?.find((p) => p.kind === choice);
    setScope((s) => ({ ...s, secrets: profile ? [...profile.recommendedSecrets] : [], hosts: profile ? [...profile.recommendedHosts] : [] }));
    if (choice !== "script") {
      setAgentId((id) => (id === "demo-planner" ? `${choice}-planner` : id));
      setBuilderAgentId((id) => (id === "demo-builder" ? `${choice}-builder` : id));
    }
  };

  const agentConfig = (prompt?: string): AgentProfileConfig | undefined =>
    usingRealAgent ? { kind: agentChoice, ...(agentBinary.trim() ? { binary: agentBinary.trim() } : {}), ...(prompt ? { prompt } : {}) } : undefined;
  const [plannerCommand, setPlannerCommand] = useState("agentguard-intent-demo-planner");
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
        return setFolderAccess(s, folder || "/workspace", "read_write");
      }
      case "network": return { ...s, hosts: [...s.hosts, gap.requested] };
      case "secret": return { ...s, secrets: [...s.secrets, gap.requested] };
      case "mcp_server": return { ...s, mcpServers: [...s.mcpServers, gap.requested] };
      case "tool": return { ...s, tools: [...s.tools, gap.requested] };
    }
  });

  const analyzePrompt = async () => {
    setError(null);
    const analysis = await previewRequest(prompt);
    setPreview(analysis);
    setObjectives(analysis.objectives.map((item) => item.text));
    setConstraints(analysis.explicitConstraints.map((item) => item.text));
  };

  const edited = Boolean(preview) && (
    JSON.stringify(objectives) !== JSON.stringify(preview?.objectives.map((item) => item.text)) ||
    JSON.stringify(constraints) !== JSON.stringify(preview?.explicitConstraints.map((item) => item.text))
  );

  const submitRequest = async () => {
    setError(null);
    const clean = (items: string[]) => items.map((item) => item.trim()).filter(Boolean);
    const result = await createRequest(edited
      ? { taskId, rawPrompt: prompt, requestedObjectives: clean(objectives), explicitConstraints: clean(constraints), analysisMode: "manual" }
      : { taskId, rawPrompt: prompt });
    setRequestResult(result);
    setIntent(null);
    setAlignment(null);
  };

  const editRequest = () => {
    setRequestResult(null);
    setIntent(null);
    setAlignment(null);
    setAccessGaps(null);
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
    <p className="text-sm font-semibold">Coding agent &amp; project</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block text-sm"><span className={labelCls}>Coding agent</span>
        <select value={agentChoice} onChange={(e) => chooseAgent(e.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm">
          <option value="script">Shell command (demo scripts / custom)</option>
          {(profiles.data ?? []).filter((p) => PICKABLE_KINDS.includes(p.kind)).map((p) => <option key={p.kind} value={p.kind}>{p.displayName}</option>)}
        </select>
        {profiles.error && <span className="mt-1 block text-xs text-[#9a3d31]">Could not load agent profiles: {profiles.error}</span>}
      </label>
      <label className="block text-sm"><span className={labelCls}>Project repository</span><input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="Path on the machine running Periscope" className={inputCls} /></label>
      <label className="block text-sm"><span className={labelCls}>Isolation</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as RuntimeProviderKind)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm">
          <option value="process">process — no isolation, runs on this machine on a temp copy</option>
          <option value="docker">docker — disposable container (image built automatically)</option>
          <option value="lima">lima — disposable VM (strongest isolation; macOS/Linux)</option>
        </select>
      </label>
      {usingRealAgent && <label className="block text-sm"><span className={labelCls}>Agent binary (optional override)</span><input value={agentBinary} onChange={(e) => setAgentBinary(e.target.value)} placeholder={selectedProfile ? `default: ${agentChoice === "claude_code" ? "claude" : agentChoice === "cursor" ? "agent" : agentChoice}` : ""} className={inputCls} /></label>}
    </div>
    {agentChoice === "devin" && <p className="text-xs text-[#64717c]">Devin works in its own cloud VM, so Periscope cannot observe it directly. The bridge starts a Devin session via the API (needs <span className="mono">DEVIN_API_KEY</span>); the planner returns structured intent, the builder pushes its work to branch <span className="mono">agentguard/&lt;run id&gt;</span> of the repo&apos;s <span className="mono">origin</span> (Devin needs push access), which is then applied to the workspace and diffed. Devin&apos;s messages are agent-reported evidence.</p>}
    <RuntimeStatusPanel provider={provider} agentKind={usingRealAgent ? agentChoice : undefined} />
    {usingRealAgent && selectedProfile && <p className="text-xs text-[#64717c]">{selectedProfile.description}</p>}
    {provider === "process" && <p className="text-xs text-[#815017]">Process mode has no sandbox. The agent works in a temporary repository copy, but the rest of the machine, network, and keys remain reachable.</p>}
  </div>;

  return <div className="mx-auto max-w-4xl space-y-3">
    <div className="mb-7"><p className="eyebrow">Start a task</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">New request</h1><p className="mt-2 max-w-2xl text-sm text-[#64717c]">Describe the task, review the coding plan and access, then start the agent.</p></div>
    {error && <ErrorBanner message={error} />}

    <Section eyebrow="Step 1" title="Describe the task" action={requestResult && <div className="flex items-center gap-2"><span className="status status-good"><Check className="mr-1 size-3.5" />recorded</span><button type="button" onClick={editRequest} className="rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold hover:bg-[#f0f2f3]">Edit request</button></div>}>
      <div className="space-y-3">
        <label className="block text-sm"><span className={labelCls}>Task name</span><input value={taskId} disabled={Boolean(requestResult)} onChange={(e) => setTaskId(e.target.value)} placeholder="Fix the login session bug" className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f0f2f3]" /></label>
        <label className="block text-sm"><span className={labelCls}>Prompt</span><textarea value={prompt} disabled={Boolean(requestResult)} onChange={(e) => { setPrompt(e.target.value); setPreview(null); }} rows={4} placeholder="Describe what the agent should do and any restrictions it must follow." className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm disabled:bg-[#f0f2f3]" /></label>
        {!requestResult && !preview && <div className="flex flex-wrap gap-2">
          <ActionButton disabled={!prompt.trim() || !taskId.trim()} onClick={async () => { try { await analyzePrompt(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Analyze prompt</ActionButton>
          <ActionButton variant="secondary" onClick={() => { setTaskId("Fix the login session bug"); setPrompt(DEMO_PROMPT); setPreview(null); }}>Use demo request</ActionButton>
        </div>}
        {!requestResult && preview && <div className="space-y-3 rounded-xl border bg-[#f6f2ec] p-4">
          <div>
            <p className="text-sm font-semibold">Review what will be recorded</p>
            <p className="mt-1 text-xs text-[#64717c]">Edit, add, or remove anything the extraction got wrong. Changing the prompt returns you to the Analyze prompt step.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <EditableList label="Objectives" items={objectives} onChange={setObjectives} placeholder="What should the agent accomplish?" />
            <EditableList label="Explicit constraints" items={constraints} onChange={setConstraints} placeholder="What must the agent avoid or preserve?" />
          </div>
          <dl className="grid gap-3 border-t pt-3 md:grid-cols-2">
            <KeyValue label="Detected restrictions"><Chips items={preview.explicitlyForbiddenResources.map((item) => item.resource)} /></KeyValue>
            <KeyValue label="Needs clarification"><Chips items={preview.ambiguities} mono={false} /></KeyValue>
            {preview.inferredExpectations.length > 0 && <div className="md:col-span-2"><KeyValue label="System suggestions"><Chips items={preview.inferredExpectations.map((item) => item.text)} mono={false} /></KeyValue></div>}
          </dl>
          <ActionButton disabled={objectives.every((item) => !item.trim())} onClick={async () => { try { await submitRequest(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Record request{edited ? " (edited)" : ""}</ActionButton>
        </div>}
        {requestResult && <dl className="grid gap-3 rounded-xl border bg-[#f6f2ec] p-4 md:grid-cols-2">
          <KeyValue label="Objectives"><ProvenanceChips items={requestResult.analysis.objectives} /></KeyValue>
          <KeyValue label="Explicit constraints"><ProvenanceChips items={requestResult.analysis.explicitConstraints} /></KeyValue>
          <div className="md:col-span-2"><KeyValue label="Detected restrictions"><div><Chips items={requestResult.analysis.explicitlyForbiddenResources.map((r) => r.resource)} /><p className="mt-1 text-xs text-[#64717c]">Used to check the plan and observed behavior. Access is configured separately.</p></div></KeyValue></div>
          {requestResult.analysis.ambiguities.length > 0 && <div className="md:col-span-2"><KeyValue label="Needs clarification"><Chips items={requestResult.analysis.ambiguities} mono={false} /></KeyValue></div>}
          {requestResult.analysis.inferredExpectations.length > 0 && <details className="md:col-span-2 text-sm"><summary className="cursor-pointer font-semibold text-[#64717c]">System suggestions ({requestResult.analysis.inferredExpectations.length})</summary><div className="mt-2"><Chips items={requestResult.analysis.inferredExpectations.map((o) => o.text)} mono={false} /><p className="mt-1 text-xs text-[#64717c]">Suggestions are informational and do not restrict the agent.</p></div></details>}
        </dl>}
      </div>
    </Section>

    <div className="flex justify-center text-[#98a4ad]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 2" title="Review plan and access" action={intent && <AlignmentBadge status={alignment?.alignment?.status ?? intent.alignment?.status} large />}>
      {!requestResult ? <p className="text-sm text-[#64717c]">Record the request first.</p> : !intent ? <div className="space-y-3">
        {agentWorkspaceFields}
        <AccessScopeEditor scope={scope} onChange={setScope} provider={provider} plannerOnly={intentMode === "planner"} repoPath={repoPath} />
        {intentMode === "planner" && <p className="text-sm text-[#64717c]">Generating a plan lets the selected agent inspect a read-only copy of the project before any coding begins.</p>}
        <details className="rounded-xl border bg-white p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Advanced plan options</summary>
          <div className="mt-3 space-y-3">
            <label className="block"><span className={labelCls}>Plan source</span><select value={intentMode} onChange={(e) => setIntentMode(e.target.value as "planner" | "manual")} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"><option value="planner">Generate automatically</option><option value="manual">Import plan JSON</option></select></label>
            {intentMode === "planner" && !usingRealAgent && <label className="block"><span className={labelCls}>Planning command</span><input value={plannerCommand} onChange={(e) => setPlannerCommand(e.target.value)} className={inputCls} /></label>}
            {intentMode === "manual" && <label className="block"><span className={labelCls}>Plan JSON</span><textarea value={intentJson} onChange={(e) => setIntentJson(e.target.value)} rows={14} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-xs" /></label>}
          </div>
        </details>
        <ActionButton onClick={async () => { try { await submitIntent(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>{intentMode === "planner" ? "Generate plan" : "Import plan"}</ActionButton>
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
            <p className="mt-2 text-xs text-[#64717c]">These come from the agent&apos;s own plan. Grant only what you agree with. Denied network access and keys are blocked; other attempts are recorded for review.</p>
            <ul className="mt-3 space-y-2">{accessGaps.gaps.map((gap) => <li key={`${gap.kind}:${gap.requested}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-sm">
              <span><span className="mono font-semibold">{gap.requested}</span> <span className="text-[#64717c]">— {gap.reason}</span> <span className={`status ${gap.enforcement === "blocked" ? "status-good" : gap.enforcement === "flagged" ? "status-warn" : "status-muted"}`}>{gap.enforcement === "blocked" ? "blocked if denied" : gap.enforcement === "flagged" ? "flagged if attempted" : "agent-reported only"}</span></span>
              <ActionButton variant="secondary" onClick={() => grant(gap)}>Grant</ActionButton>
            </li>)}</ul>
          </>}
        </div>
        <div className="rounded-xl border bg-[#f6f2ec] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Request → Plan comparison</p><AlignmentBadge status={alignment?.alignment?.status} /></div>
          {alignment && alignment.findings.length === 0 && <p className="mt-2 text-sm text-[#64717c]">No pre-execution findings. The plan does not contradict any explicit constraint or miss a requested objective.</p>}
          <div className="mt-3 grid gap-3">{alignment?.findings.map((f) => <FindingCard key={f.id} finding={f} onChanged={() => refreshAlignment(intent.id)} />)}</div>
          {blocked && <p className="mt-3 text-sm text-[#9a3d31]">Execution blocked: {blocked}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {alignment?.approval ? <span className={`status ${alignment.approval.status === "approved" ? "status-good" : "status-bad"}`}>{alignment.approval.status}{alignment.approval.actor && ` by ${alignment.approval.actor}`}</span> : <>
            <ActionButton onClick={async () => { await approveIntent(intent.id, { actor: "human", reason: "Approved from new-request flow" }); await refreshAlignment(intent.id); }}>Approve plan</ActionButton>
            <ActionButton variant="danger" onClick={async () => { await rejectIntent(intent.id, { actor: "human", reason: "Rejected from new-request flow" }); await refreshAlignment(intent.id); }}>Reject plan</ActionButton>
          </>}
          <ActionButton variant="secondary" onClick={() => { setIntent(null); setAlignment(null); }}>Generate a different plan</ActionButton>
        </div>
      </div>}
    </Section>

    <div className="flex justify-center text-[#98a4ad]"><ArrowDown className="size-5" /></div>

    <Section eyebrow="Step 3" title="Start coding">
      {!intent ? <p className="text-sm text-[#64717c]">Generate a plan first so Periscope can compare the requested work with what the agent intends to do.</p> : <div className="space-y-3">
        <p className="text-sm text-[#64717c]">{usingRealAgent ? selectedProfile?.displayName ?? agentChoice : "The configured command"} will work in <span className="mono">{repoPath}</span> using {provider} isolation.</p>
        <details className="rounded-xl border bg-white p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Advanced coding options</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block"><span className={labelCls}>Agent ID</span><input value={builderAgentId} onChange={(e) => setBuilderAgentId(e.target.value)} className={inputCls} /></label>
            {!usingRealAgent && <label className="block"><span className={labelCls}>Coding command</span><input value={builderCommand} onChange={(e) => setBuilderCommand(e.target.value)} className={inputCls} /></label>}
          </div>
        </details>
        <div className="rounded-xl border bg-[#f6f2ec] p-4">
          <p className="text-sm font-semibold">The coding run will start with this access</p>
          <ul className="mt-2 space-y-0.5 text-sm">{summarizeScope(scope, provider).map((line) => <li key={line}>{line}</li>)}</ul>
          {accessGaps && accessGaps.gaps.length > 0 && <p className="mt-2 text-xs text-[#815017]">{accessGaps.gaps.length} item{accessGaps.gaps.length === 1 ? "" : "s"} from the plan {accessGaps.gaps.length === 1 ? "is" : "are"} still denied. Attempts will appear in the workbench.</p>}
          <details className="mt-2 text-sm"><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-[#64717c]">Adjust access</summary><div className="mt-2"><AccessScopeEditor scope={scope} onChange={setScope} provider={provider} repoPath={repoPath} /></div></details>
        </div>
        {blocked && <p className="text-sm text-[#9a3d31]">{blocked}</p>}
        <ActionButton disabled={Boolean(blocked)} onClick={async () => { try { await startRun(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }}>Start coding</ActionButton>
      </div>}
    </Section>
  </div>;
}

function EditableList({ label, items, onChange, placeholder }: { label: string; items: string[]; onChange: (items: string[]) => void; placeholder: string }) {
  return <div>
    <p className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">{label}</p>
    <ul className="mt-1.5 space-y-1.5">
      {items.map((item, index) => <li key={index} className="flex items-center gap-1.5">
        <input value={item} placeholder={placeholder} autoFocus={item === "" && index === items.length - 1} onChange={(event) => onChange(items.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} className="w-full rounded-lg border bg-white px-3 py-1.5 text-sm text-[#14212a]" />
        <button type="button" aria-label={"Remove " + label.toLowerCase() + " item"} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md p-1.5 text-[#64717c] hover:bg-white hover:text-[#8c2f26]"><X className="size-3.5" /></button>
      </li>)}
    </ul>
    <button type="button" onClick={() => onChange([...items, ""])} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-[#64717c] hover:text-[#182a33]"><Plus className="size-3.5" />Add</button>
  </div>;
}

function ProvenanceChips({ items }: { items: RequestAnalysis["objectives"] }) {
  if (!items.length) return <span className="text-sm text-[#64717c]">none</span>;
  return <div className="flex flex-wrap gap-1.5">{items.map((item, i) => <span key={`${item.text}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border bg-[#e6e9eb]/60 px-2 py-1 text-xs">{item.text}<span className={`status ${item.source === "caller" ? "status-info" : "status-muted"} !px-1.5 !py-0 text-[10px]`}>{item.source === "caller" ? "human-edited" : "extracted"}</span></span>)}</div>;
}
