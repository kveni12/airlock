"use client";

import { useState } from "react";
import { getAgentProfiles } from "@/lib/api";
import type { AgentProfile, Project, ProjectInput, RuntimeProviderKind } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { AccessScopeEditor, type AccessScope } from "./access-scope";
import { ActionButton, ErrorBanner } from "./ui";

const PICKABLE_KINDS = ["claude_code", "codex", "opencode", "cursor", "devin"];
const inputCls = "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm";
const labelCls = "text-xs font-semibold uppercase tracking-wider text-[#64717c]";

export const EMPTY_PROJECT: ProjectInput = {
  name: "",
  repoPath: "",
  runtime: "docker",
  scope: { folders: [{ path: "/workspace", access: "read" }], hosts: [], secrets: [], mcpServers: [], tools: ["filesystem", "shell"] }
};

export function toInput(project: Project): ProjectInput {
  const { name, repoPath, branch, agentKind, runtime, scope, notes } = project;
  return { name, repoPath, branch, agentKind, runtime, scope, notes };
}

export function ProjectForm({ initial, submitLabel, onSubmit, onCancel }: { initial: ProjectInput; submitLabel: string; onSubmit: (input: ProjectInput) => Promise<unknown>; onCancel?: () => void }) {
  const profiles = useResource<AgentProfile[]>((signal) => getAgentProfiles(signal), 60_000);
  const [draft, setDraft] = useState<ProjectInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ProjectInput>) => setDraft((d) => ({ ...d, ...patch }));

  const chooseAgent = (kind: string) => {
    const profile = profiles.data?.find((p) => p.kind === kind);
    setDraft((d) => ({
      ...d,
      agentKind: kind || undefined,
      scope: { ...d.scope, secrets: profile ? [...profile.recommendedSecrets] : d.scope.secrets }
    }));
  };

  const submit = async () => {
    setError(null);
    if (!draft.name.trim()) return setError("Give the project a name.");
    if (!draft.repoPath.trim()) return setError("Enter the repo path on the machine running the backend.");
    try {
      await onSubmit({ ...draft, name: draft.name.trim(), repoPath: draft.repoPath.trim(), branch: draft.branch?.trim() || undefined, notes: draft.notes?.trim() || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return <div className="space-y-4">
    {error && <ErrorBanner message={error} />}
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block text-sm"><span className={labelCls}>Project name</span><input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. billing-service" className={inputCls} /></label>
      <label className="block text-sm"><span className={labelCls}>Repo path (on the machine running the backend)</span><input value={draft.repoPath} onChange={(e) => set({ repoPath: e.target.value })} placeholder="/Users/you/code/my-app" className={`${inputCls} mono`} /></label>
      <label className="block text-sm"><span className={labelCls}>Branch (optional)</span><input value={draft.branch ?? ""} onChange={(e) => set({ branch: e.target.value })} placeholder="main" className={`${inputCls} mono`} /></label>
      <label className="block text-sm"><span className={labelCls}>Default agent</span>
        <select value={draft.agentKind ?? ""} onChange={(e) => chooseAgent(e.target.value)} className={inputCls}>
          <option value="">Shell command (demo scripts / custom)</option>
          {(profiles.data ?? []).filter((p) => PICKABLE_KINDS.includes(p.kind)).map((p) => <option key={p.kind} value={p.kind}>{p.displayName}</option>)}
        </select>
      </label>
      <label className="block text-sm"><span className={labelCls}>Sandbox runtime</span>
        <select value={draft.runtime} onChange={(e) => set({ runtime: e.target.value as RuntimeProviderKind })} className={inputCls}>
          <option value="docker">docker — container (kernel-enforced file scope)</option>
          <option value="lima">lima — disposable VM</option>
          <option value="process">process — no isolation, runs on this machine</option>
        </select>
      </label>
      <label className="block text-sm md:col-span-2"><span className={labelCls}>Notes (optional)</span><textarea value={draft.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} rows={2} placeholder="What this project is, conventions the agent should know…" className={inputCls} /></label>
    </div>
    <AccessScopeEditor scope={draft.scope as AccessScope} onChange={(scope) => set({ scope })} provider={draft.runtime} repoPath={draft.repoPath} />
    <div className="flex flex-wrap gap-2">
      <ActionButton onClick={submit}>{submitLabel}</ActionButton>
      {onCancel && <ActionButton variant="secondary" onClick={onCancel}>Cancel</ActionButton>}
    </div>
  </div>;
}
