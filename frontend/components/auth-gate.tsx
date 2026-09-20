"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Image from "next/image";
import { AgentGuardApiError, bootstrapAdmin, getAuthStatus, getCurrentUser, googleSignInUrl, login, logout } from "@/lib/api";
import type { PublicUser } from "@/lib/contracts";

interface AuthState {
  user: PublicUser | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ user: null, signOut: async () => {} });

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

type Phase = "loading" | "login" | "setup" | "ready" | "offline";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [offlineMessage, setOfflineMessage] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUser(await getCurrentUser());
      setPhase("ready");
      return;
    } catch (error) {
      if (!(error instanceof AgentGuardApiError) || error.status !== 401) {
        setOfflineMessage(error instanceof Error ? error.message : String(error));
        setPhase("offline");
        return;
      }
    }
    try {
      const status = await getAuthStatus();
      setGoogleEnabled(Boolean(status.googleEnabled));
      setPhase(status.needsBootstrap ? "setup" : "login");
    } catch (error) {
      setOfflineMessage(error instanceof Error ? error.message : String(error));
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await logout().catch(() => undefined);
    setUser(null);
    setPhase("loading");
    await refresh();
  }, [refresh]);

  if (phase === "loading") return <CenteredCard><p className="text-sm text-[#64717c]">Checking your session…</p></CenteredCard>;
  if (phase === "offline") {
    return <CenteredCard>
      <h1 className="text-lg font-semibold">Backend unavailable</h1>
      <p className="mt-2 text-sm text-[#64717c]">{offlineMessage}</p>
      <button onClick={() => void refresh()} className="mt-5 w-full rounded-lg bg-[#182a33] px-3 py-2 text-sm font-semibold text-white">Retry</button>
    </CenteredCard>;
  }
  if (phase === "setup") return <CenteredCard><SetupForm onDone={(created) => { setUser(created); setPhase("ready"); }} /></CenteredCard>;
  if (phase === "login") return <CenteredCard><LoginForm googleEnabled={googleEnabled} onDone={(signedIn) => { setUser(signedIn); setPhase("ready"); }} /></CenteredCard>;

  return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center bg-[#fbfbfa] p-6">
    <div className="card w-full max-w-sm p-6">
      <div className="mb-6 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-[#182a33]"><Image src="/periscope-mark.png" alt="" width={24} height={24} priority /></span>
        <span className="text-sm uppercase tracking-[.18em]">Periscope</span>
      </div>
      {children}
    </div>
  </div>;
}

const inputCls = "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm";
const labelCls = "text-xs font-semibold uppercase tracking-wider text-[#64717c]";
const submitCls = "mt-5 w-full rounded-lg bg-[#182a33] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60";

function LoginForm({ googleEnabled, onDone }: { googleEnabled: boolean; onDone: (user: PublicUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleHref, setGoogleHref] = useState("");

  // Runs in the browser: the return path and the Google callback's ?authError= are both in the URL.
  useEffect(() => {
    const reported = new URLSearchParams(window.location.search).get("authError");
    if (reported) setError(reported);
    setGoogleHref(googleSignInUrl(window.location.pathname));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await login(email, password));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return <form onSubmit={submit}>
    <h1 className="text-lg font-semibold">Sign in</h1>
    <p className="mt-1 text-sm text-[#64717c]">Governance actions are recorded against your account.</p>
    <label className="mt-5 block text-sm"><span className={labelCls}>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} required /></label>
    <label className="mt-3 block text-sm"><span className={labelCls}>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} required /></label>
    {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    <button type="submit" disabled={busy} className={submitCls}>{busy ? "Signing in…" : "Sign in"}</button>
    {googleEnabled ? <>
      <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wider text-[#64717c]"><span className="h-px flex-1 bg-[#e3e3e0]" />or<span className="h-px flex-1 bg-[#e3e3e0]" /></div>
      <a href={googleHref} className="flex w-full items-center justify-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-semibold">Continue with Google</a>
    </> : null}
  </form>;
}

function SetupForm({ onDone }: { onDone: (user: PublicUser) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await bootstrapAdmin({ email, password, displayName, setupToken }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return <form onSubmit={submit}>
    <h1 className="text-lg font-semibold">Create the first administrator</h1>
    <p className="mt-1 text-sm text-[#64717c]">The backend printed a one-time setup token to its log at startup. Paste it below.</p>
    <label className="mt-5 block text-sm"><span className={labelCls}>Name</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} /></label>
    <label className="mt-3 block text-sm"><span className={labelCls}>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} required /></label>
    <label className="mt-3 block text-sm"><span className={labelCls}>Password</span><input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} required /><span className="mt-1 block text-xs text-[#64717c]">At least 12 characters.</span></label>
    <label className="mt-3 block text-sm"><span className={labelCls}>Setup token</span><input className={`mono ${inputCls}`} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required /></label>
    {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
    <button type="submit" disabled={busy} className={submitCls}>{busy ? "Creating…" : "Create administrator"}</button>
  </form>;
}
