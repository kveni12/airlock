import { createHash, randomBytes } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Empty lists mean nobody may self-provision: only accounts an admin already created can sign in. */
  allowedEmails: string[];
  allowedDomains: string[];
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string;
}

interface PendingAuthorization {
  codeVerifier: string;
  returnTo: string;
  createdAt: number;
}

/** Reads the configuration, returning undefined when Google sign-in is simply not set up. */
export function resolveGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | undefined {
  const clientId = env.PERISCOPE_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.PERISCOPE_GOOGLE_CLIENT_SECRET?.trim();
  const publicUrl = env.PERISCOPE_PUBLIC_URL?.trim().replace(/\/$/, "");
  const redirectUri = env.PERISCOPE_GOOGLE_REDIRECT_URI?.trim() || (publicUrl ? `${publicUrl}/api/auth/google/callback` : undefined);
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return {
    clientId,
    clientSecret,
    redirectUri,
    allowedEmails: splitList(env.PERISCOPE_GOOGLE_ALLOWED_EMAILS).map((entry) => entry.toLowerCase()),
    allowedDomains: splitList(env.PERISCOPE_GOOGLE_ALLOWED_DOMAINS).map((entry) => entry.toLowerCase().replace(/^@/, ""))
  };
}

/**
 * An allowlisted address may sign in without an account existing first; everyone else has to be
 * created by an administrator. Defaulting to "no self-provisioning" matters here because a Periscope
 * session can start agent runs on the host.
 */
export function mayProvision(email: string, config: GoogleOAuthConfig): boolean {
  const normalized = email.toLowerCase();
  const domain = normalized.split("@")[1] ?? "";
  return config.allowedEmails.includes(normalized) || config.allowedDomains.includes(domain);
}

/** Authorization requests awaiting their callback, keyed by the `state` handed to Google. */
export class GoogleAuthorizationStore {
  private readonly pending = new Map<string, PendingAuthorization>();

  start(config: GoogleOAuthConfig, returnTo: string): { url: string; state: string } {
    this.prune();
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { codeVerifier, returnTo, createdAt: Date.now() });

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    return { url: url.toString(), state };
  }

  /** Single use: a replayed `state` finds nothing and the callback is rejected. */
  claim(state: string | undefined): PendingAuthorization | undefined {
    this.prune();
    if (!state) return undefined;
    const entry = this.pending.get(state);
    if (entry) this.pending.delete(state);
    return entry;
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

export async function exchangeCodeForIdentity(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<GoogleIdentity> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier
    })
  });
  if (!response.ok) throw new Error(`Google rejected the authorization code (${response.status})`);
  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== "string") throw new Error("Google did not return an identity token");
  return readIdentityToken(payload.id_token);
}

/**
 * Reads the claims without verifying the signature: the token came straight back from Google's
 * token endpoint over TLS in response to our client secret, so there is no third party to forge it.
 */
export function readIdentityToken(idToken: string): GoogleIdentity {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new Error("Malformed identity token");
  const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as Record<string, unknown>;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!email || !subject) throw new Error("Google account is missing an email address");
  if (claims.email_verified === false) throw new Error("Google account email is not verified");
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { subject, email, displayName: name };
}

/** Keeps an open redirect out of the callback: only in-app paths are honoured. */
export function safeReturnPath(candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  return candidate;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
