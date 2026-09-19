"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { getRequestRules, previewRequest, resetRequestRules, updateRequestRules } from "@/lib/api";
import type { LexiconCategory, RequestAnalysis, RequestAnalyzerRules } from "@/lib/contracts";
import { useResource } from "@/lib/use-resource";
import { ActionButton, Chips, ErrorBanner, KeyValue, Section } from "./ui";

const CATEGORIES: LexiconCategory[] = ["database", "infrastructure", "dependencies", "network", "secrets", "tests", "configuration"];
const SAMPLE = "Fix the login/session bug and add a regression test.\nDo not modify database or infrastructure configuration.\nDo not add external dependencies.";

const lines = (value: string) => value.split("\n").map((s) => s.trim()).filter(Boolean);
const pairs = (value: string, sep: string) => lines(value).map((line) => {
  const idx = line.indexOf(sep);
  return idx === -1 ? [line, ""] : [line.slice(0, idx).trim(), line.slice(idx + sep.length).trim()];
});

interface Draft {
  prohibitions: string;
  hedges: string;
  verbs: string;
  lexicon: Record<LexiconCategory, string>;
  expectations: string;
}

function toDraft(rules: RequestAnalyzerRules): Draft {
  return {
    prohibitions: rules.prohibitionPatterns.join("\n"),
    hedges: rules.hedgePatterns.map((h) => `${h.pattern} => ${h.label}`).join("\n"),
    verbs: rules.imperativeVerbs.join(", "),
    lexicon: Object.fromEntries(CATEGORIES.map((c) => [c, (rules.resourceLexicon[c] ?? []).join(", ")])) as Record<LexiconCategory, string>,
    expectations: rules.inferredExpectations.map((e) => `${e.when} => ${e.text}`).join("\n")
  };
}

function fromDraft(draft: Draft, base: RequestAnalyzerRules): RequestAnalyzerRules {
  return {
    ...base,
    prohibitionPatterns: lines(draft.prohibitions),
    hedgePatterns: pairs(draft.hedges, "=>").map(([pattern, label]) => ({ pattern, label })),
    imperativeVerbs: draft.verbs.split(",").map((s) => s.trim()).filter(Boolean),
    resourceLexicon: Object.fromEntries(CATEGORIES.map((c) => [c, draft.lexicon[c].split(",").map((s) => s.trim()).filter(Boolean)])) as Record<LexiconCategory, string[]>,
    inferredExpectations: pairs(draft.expectations, "=>").map(([when, text]) => ({ when, text }))
  };
}

function badRegex(source: string): string | null {
  try {
    new RegExp(source, "i");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function RequestRulesEditor() {
  const loadRules = useCallback((signal: AbortSignal) => getRequestRules(signal), []);
  const rules = useResource<RequestAnalyzerRules>(loadRules, 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<RequestAnalyzerRules | null>(null);
  const [sample, setSample] = useState(SAMPLE);
  const [preview, setPreview] = useState<RequestAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (rules.data && !saved) { setSaved(rules.data); setDraft(toDraft(rules.data)); }
  }, [rules.data, saved]);

  if (rules.error && !saved) return <ErrorBanner message={rules.error} onRetry={rules.refresh} />;
  if (!draft || !saved) return <div className="skeleton h-40" />;

  const candidate = fromDraft(draft, saved);
  const regexErrors = [
    ...candidate.prohibitionPatterns.map((p) => [p, badRegex(p)] as const),
    ...candidate.hedgePatterns.map((h) => [h.pattern, badRegex(h.pattern)] as const),
    ...candidate.inferredExpectations.map((e) => [e.when, badRegex(e.when)] as const)
  ].filter(([, err]) => err);
  const dirty = JSON.stringify(toDraft(candidate)) !== JSON.stringify(toDraft(saved));

  const run = async (fn: () => Promise<void>) => {
    setError(null); setFlash(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; }
  };

  const area = (label: string, hint: string, value: string, onChange: (v: string) => void, rows = 6) => <label className="block text-sm">
    <span className="text-xs font-semibold uppercase tracking-wider text-[#64717c]">{label}</span>
    <span className="block text-xs text-[#64717c]">{hint}</span>
    <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} spellCheck={false} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-2 text-xs leading-5 text-[#14212a]" />
  </label>;

  return <div className="space-y-6">
    <div>
      <Link href="/requests/new" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#64717c] hover:text-[#182a33]"><ArrowLeft className="size-3.5" />New request</Link>
      <p className="eyebrow mt-3">Request analyzer</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-[-.04em]">Extraction rules</h1>
      <p className="mt-1 max-w-2xl text-sm text-[#64717c]">Deterministic regex/keyword rules that turn a prompt into objectives, constraints, forbidden resources and ambiguities. No model is involved. Patterns are JavaScript regular expressions matched case-insensitively against each sentence. Every recorded analysis is stamped with the rule revision used.</p>
    </div>

    {error && <ErrorBanner message={error} />}
    {flash && <div className="flex items-center gap-2 rounded-xl border border-[#9bd7b5] bg-[#effaf3] px-4 py-3 text-sm text-[#14623f]"><Check className="size-4" />{flash}</div>}
    {regexErrors.length > 0 && <div className="rounded-xl border border-[#e3a59b] bg-[#fff1ee] px-4 py-3 text-sm text-[#8c2f26]">Invalid regex: {regexErrors.map(([p, e]) => <span key={p} className="mono block text-xs">{p} — {e}</span>)}</div>}

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Section eyebrow="Sentences" title="Constraints vs objectives">
          <div className="grid gap-4 md:grid-cols-2">
            {area("Prohibition patterns", "One regex per line. A sentence matching any of these becomes an explicit constraint; other sentences become objectives.", draft.prohibitions, (v) => setDraft({ ...draft, prohibitions: v }), 9)}
            {area("Imperative verbs", "Comma-separated. \"A and B\" is split into two objectives only when both halves start with one of these.", draft.verbs, (v) => setDraft({ ...draft, verbs: v }), 9)}
          </div>
        </Section>
        <Section eyebrow="Resources" title="Resource lexicon">
          <p className="mb-3 text-xs text-[#64717c]">Comma-separated keywords per category. Words found in a constraint become forbidden resources; in an objective, requested resources.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {CATEGORIES.map((c) => <label key={c} className="block text-sm"><span className="mono text-xs font-semibold text-[#182a33]">{c}</span><input value={draft.lexicon[c]} onChange={(e) => setDraft({ ...draft, lexicon: { ...draft.lexicon, [c]: e.target.value } })} spellCheck={false} className="mono mt-1 w-full rounded-lg border bg-white px-3 py-1.5 text-xs text-[#14212a]" /></label>)}
          </div>
        </Section>
        <Section eyebrow="Signals" title="Ambiguities and inferred expectations">
          <div className="grid gap-4 md:grid-cols-2">
            {area("Hedge patterns", "regex => label, one per line. A matching sentence is reported as an ambiguity with that label.", draft.hedges, (v) => setDraft({ ...draft, hedges: v }), 8)}
            {area("Inferred expectations", "regex => text, one per line. When the whole prompt matches the regex the text is added as an inferred (not explicit) expectation. Use .* to always add it.", draft.expectations, (v) => setDraft({ ...draft, expectations: v }), 8)}
          </div>
        </Section>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton disabled={!dirty || regexErrors.length > 0} onClick={() => run(async () => { const next = await updateRequestRules(candidate); setSaved(next); setDraft(toDraft(next)); setFlash(`Saved as revision ${next.revision}.`); })}>Save rules</ActionButton>
          <ActionButton variant="secondary" disabled={!dirty} onClick={() => setDraft(toDraft(saved))}>Discard changes</ActionButton>
          <ActionButton variant="danger" confirm="Reset all rules to the built-in defaults? This creates a new revision." onClick={() => run(async () => { const next = await resetRequestRules(); setSaved(next); setDraft(toDraft(next)); setFlash(`Reset to defaults as revision ${next.revision}.`); })}>Reset to defaults</ActionButton>
          <span className="mono ml-auto text-xs text-[#64717c]">revision {saved.revision} · updated {new Date(saved.updatedAt).toLocaleString()}</span>
        </div>
      </div>

      <div className="space-y-4">
        <Section eyebrow="Try it" title="Preview against a prompt">
          <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={5} className="w-full rounded-lg border bg-white px-3 py-2 text-sm text-[#14212a]" />
          <div className="mt-2 flex gap-2"><ActionButton disabled={regexErrors.length > 0 || !sample.trim()} onClick={() => run(async () => setPreview(await previewRequest(sample, candidate)))}>Preview with {dirty ? "unsaved" : "current"} rules</ActionButton></div>
          {preview && <dl className="mt-4 grid gap-3">
            <KeyValue label="Objectives"><Chips items={preview.objectives.map((o) => o.text)} mono={false} /></KeyValue>
            <KeyValue label="Explicit constraints"><Chips items={preview.explicitConstraints.map((o) => o.text)} mono={false} /></KeyValue>
            <KeyValue label="Forbidden resources"><Chips items={preview.explicitlyForbiddenResources.map((r) => `${r.resource} (${r.category})`)} /></KeyValue>
            <KeyValue label="Requested resources"><Chips items={preview.explicitlyRequestedResources.map((r) => `${r.resource} (${r.category})`)} /></KeyValue>
            <KeyValue label="Ambiguities"><Chips items={preview.ambiguities} mono={false} /></KeyValue>
            <KeyValue label="Inferred expectations"><Chips items={preview.inferredExpectations.map((o) => o.text)} mono={false} /></KeyValue>
          </dl>}
        </Section>
      </div>
    </div>
  </div>;
}
