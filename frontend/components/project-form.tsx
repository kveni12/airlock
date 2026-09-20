"use client";
import { localAgent } from "../../shared/local-agents.mjs";
import { useRef, useState } from "react";
import { suggestProjectPermissions, validateLocalProject } from "@/lib/api";
import type { Project, ProjectInput } from "@/lib/contracts";
import { FolderExplorer, type AccessScope } from "./access-scope";
import { RepoPathField } from "./folder-picker";
import { ActionButton, ErrorBanner } from "./ui";

const inputCls = "mt-2 w-full rounded-lg border bg-white px-3 py-2 text-sm";
export const EMPTY_PROJECT: ProjectInput = {
  name: "", repoPath: "", runtime: "docker", agentKind: "codex", humanIntent: "",
  scope: { folders: [{ path: "/workspace", access: "read" }], hosts: ["auth.openai.com", "chatgpt.com"], secrets: [], mcpServers: [], tools: ["filesystem", "shell"] }
};
export function toInput(project: Project): ProjectInput {
  const { name, repoPath, branch, agentKind, runtime, scope, notes, humanIntent } = project;
  return { name, repoPath, branch, agentKind, runtime, scope, notes, humanIntent };
}
export function ProjectForm({ initial, submitLabel, onSubmit, onCancel }: { initial: ProjectInput; submitLabel: string; onSubmit: (input: ProjectInput) => Promise<unknown>; onCancel?: () => void }) {
  const [draft, setDraft] = useState(initial);
  const agent = localAgent(draft.agentKind === "claude_code" ? "claude_code" : "codex");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const set = (patch: Partial<ProjectInput>) => { revision.current++; setDraft((d) => ({ ...d, ...patch })); };
  const suggest = async () => {
    setError(null); setBusy(true);
    const current = revision.current;
    try {
      const result = await suggestProjectPermissions(draft.repoPath, draft.humanIntent ?? "", draft.agentKind);
      if (current !== revision.current) return;
      set({ scope: result.scope });
      setWarnings(result.warnings);
      setSummary([...result.analysis.objectives.map((o) => o.text), ...result.analysis.explicitConstraints.map((c) => c.text)]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setError(null);
    if (!draft.name.trim() || !draft.repoPath.trim()) return setError("Enter a project name and select its local folder.");
    const input = { ...draft, name: draft.name.trim(), repoPath: draft.repoPath.trim(), runtime: "docker" as const, agentKind: draft.agentKind === "claude_code" ? "claude_code" : "codex", branch: undefined, scope: { ...draft.scope, hosts: draft.scope.hosts.map((h) => h.trim()).filter(Boolean) } };
    try { await validateLocalProject(input); await onSubmit(input); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="space-y-6">
    {error && <ErrorBanner message={error} />}
    <section className="space-y-3"><h3 className="font-semibold">1. Choose your project</h3>
      <label className="block text-sm">Project name<input className={inputCls} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="My project" /></label>
      <label className="block text-sm">Coding agent<select className={inputCls} value={draft.agentKind === "claude_code" ? "claude_code" : "codex"} onChange={(e) => { const kind = e.target.value; set({ agentKind: kind, scope: { ...draft.scope, hosts: [...new Set([...draft.scope.hosts, ...localAgent(kind).hosts])] } }); setSummary([]); setWarnings([]); }}><option value="codex">Codex · ChatGPT account</option><option value="claude_code">Claude Code · Claude account</option></select></label>
      <RepoPathField value={draft.repoPath} onChange={(repoPath) => { set({ repoPath, scope: { ...draft.scope, folders: [{ path: "/workspace", access: "read" }] } }); setWarnings([]); setSummary([]); }} />
    </section>
    <section className="space-y-3"><h3 className="font-semibold">2. Describe what {agent.name} may do</h3>
      <textarea aria-label="Permission description" className={inputCls} rows={3} value={draft.humanIntent ?? ""} onChange={(e) => { set({ humanIntent: e.target.value }); setSummary([]); setWarnings([]); }} placeholder="Modify src. Modify tests. Do not modify infra. Do not read or access sensitive_data." />
      <p className="text-xs text-[#64717c]">Describe permissions here; enter your task in the agent terminal after launch. This description is not sent as a prompt. Review the suggested permissions before saving, or configure them directly below.</p>
      <ActionButton variant="secondary" disabled={busy || !draft.repoPath || !draft.humanIntent?.trim()} onClick={suggest}>{busy ? "Extracting…" : "Suggest permissions from description"}</ActionButton>
      {!!summary.length && <div className="rounded-lg bg-[#f6f2ec] p-3 text-sm"><p className="font-semibold">Extracted permissions</p><ul className="mt-2 list-disc pl-5">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {!!warnings.length && <ul className="space-y-1 text-xs text-[#815017]">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </section>
    <section className="space-y-3"><h3 className="font-semibold">3. Review permissions</h3>
      <p className="text-xs text-[#64717c]">Use read-only access for the project root, then allow edits to existing subfolders. Local sessions use Docker and edit your current checkout immediately.</p>
      {draft.repoPath && <FolderExplorer repoPath={draft.repoPath} scope={draft.scope as AccessScope} onChange={(scope) => set({ scope })} />}
      <label className="block text-sm">Allowed websites<input className={inputCls} value={draft.scope.hosts.join(", ")} onChange={(e) => set({ scope: { ...draft.scope, hosts: e.target.value.split(",").map((s) => s.trim()) } })} /></label>
      <p className="text-xs text-[#64717c]">Comma-separated host names. {agent.hosts.join(", ")} are needed for account login. This controls direct connections; hosted tools may use separate access.</p>
    </section>
    {!!(draft.scope.secrets.length + draft.scope.mcpServers.length) && <div className="rounded-lg border p-3 text-xs"><p>Additional saved grants: {[...draft.scope.secrets, ...draft.scope.mcpServers].join(", ")}</p><button className="mt-2 underline" onClick={() => set({ scope: { ...draft.scope, secrets: [], mcpServers: [] } })}>Remove these additional grants</button></div>}
    <div className="flex gap-2"><ActionButton disabled={busy} onClick={submit}>{submitLabel}</ActionButton>{onCancel && <ActionButton variant="secondary" onClick={onCancel}>Cancel</ActionButton>}</div>
  </div>;
}
