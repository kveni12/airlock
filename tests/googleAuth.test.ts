import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/authService.js";
import {
  GoogleAuthorizationStore,
  exchangeCodeForIdentity,
  mayProvision,
  readIdentityToken,
  resolveGoogleConfig,
  safeReturnPath,
  type GoogleOAuthConfig
} from "../src/auth/googleOAuth.js";
import { JsonStore } from "../src/store/jsonStore.js";

const CONFIG: GoogleOAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://periscope.example/api/auth/google/callback",
  allowedEmails: ["allowed@example.com"],
  allowedDomains: ["example.org"]
};

function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

async function withStore<T>(body: (auth: AuthService, store: JsonStore) => Promise<T>): Promise<T> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "periscope-google-"));
  const store = new JsonStore(path.join(temp, "store.json"));
  await store.init();
  try {
    return await body(new AuthService(store), store);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

describe("google oauth configuration", () => {
  it("stays disabled until a client id, secret, and redirect are all present", () => {
    expect(resolveGoogleConfig({ PERISCOPE_GOOGLE_CLIENT_ID: "id" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      resolveGoogleConfig({
        PERISCOPE_GOOGLE_CLIENT_ID: "id",
        PERISCOPE_GOOGLE_CLIENT_SECRET: "secret"
      } as NodeJS.ProcessEnv)
    ).toBeUndefined();
  });

  it("derives the redirect from the public URL and normalizes the allowlists", () => {
    const config = resolveGoogleConfig({
      PERISCOPE_GOOGLE_CLIENT_ID: "id",
      PERISCOPE_GOOGLE_CLIENT_SECRET: "secret",
      PERISCOPE_PUBLIC_URL: "https://periscope.example/",
      PERISCOPE_GOOGLE_ALLOWED_EMAILS: " Someone@Example.com ",
      PERISCOPE_GOOGLE_ALLOWED_DOMAINS: "@Example.org"
    } as NodeJS.ProcessEnv);
    expect(config?.redirectUri).toBe("https://periscope.example/api/auth/google/callback");
    expect(config?.allowedEmails).toEqual(["someone@example.com"]);
    expect(config?.allowedDomains).toEqual(["example.org"]);
  });

  it("only lets allowlisted addresses create an account", () => {
    expect(mayProvision("allowed@example.com", CONFIG)).toBe(true);
    expect(mayProvision("anyone@example.org", CONFIG)).toBe(true);
    expect(mayProvision("stranger@gmail.com", CONFIG)).toBe(false);
    expect(mayProvision("stranger@gmail.com", { ...CONFIG, allowedEmails: [], allowedDomains: [] })).toBe(false);
  });
});

describe("authorization handshake", () => {
  it("builds a PKCE authorization URL and burns the state after one use", () => {
    const store = new GoogleAuthorizationStore();
    const { url, state } = store.start(CONFIG, "/runs");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(state);

    expect(store.claim(state)?.returnTo).toBe("/runs");
    expect(store.claim(state)).toBeUndefined();
    expect(store.claim("never-issued")).toBeUndefined();
  });

  it("refuses to redirect anywhere but back into the app", () => {
    expect(safeReturnPath("/runs?tab=live")).toBe("/runs?tab=live");
    expect(safeReturnPath("//evil.example/steal")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath(undefined)).toBe("/");
  });

  it("reads the identity claims and rejects unverified or malformed tokens", () => {
    expect(readIdentityToken(idToken({ sub: "g-1", email: "Person@Example.com", name: " Person " }))).toEqual({
      subject: "g-1",
      email: "person@example.com",
      displayName: "Person"
    });
    expect(() => readIdentityToken(idToken({ sub: "g-1", email: "p@example.com", email_verified: false }))).toThrow(
      /not verified/
    );
    expect(() => readIdentityToken("not-a-token")).toThrow(/Malformed/);
  });

  it("exchanges the code with the verifier and surfaces Google's rejection", async () => {
    let body: URLSearchParams | undefined;
    const identity = await exchangeCodeForIdentity(CONFIG, "the-code", "the-verifier", (async (_url, init) => {
      body = (init as RequestInit).body as URLSearchParams;
      return new Response(JSON.stringify({ id_token: idToken({ sub: "g-2", email: "p@example.org" }) }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch);
    expect(body?.get("code_verifier")).toBe("the-verifier");
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(identity.subject).toBe("g-2");

    await expect(
      exchangeCodeForIdentity(CONFIG, "bad", "verifier", (async () => new Response("no", { status: 400 })) as typeof fetch)
    ).rejects.toThrow(/rejected the authorization code/);
  });
});

describe("signing in with a google identity", () => {
  const identity = { subject: "g-10", email: "person@example.org", displayName: "Person" };

  it("creates an operator only when provisioning is allowed", async () => {
    await withStore(async (auth) => {
      await expect(auth.loginWithGoogle(identity, false)).rejects.toThrow(/not allowed to sign in/);
      const { user } = await auth.loginWithGoogle(identity, true);
      expect(user).toMatchObject({ email: identity.email, displayName: "Person", role: "operator" });
      expect(user).not.toHaveProperty("passwordHash");
    });
  });

  it("links an existing password account by email and keeps its role", async () => {
    await withStore(async (auth, store) => {
      const created = await auth.createUser({
        email: identity.email,
        password: "a-long-enough-password",
        role: "admin"
      });
      const { user } = await auth.loginWithGoogle(identity, false);
      expect(user.id).toBe(created.id);
      expect(user.role).toBe("admin");
      expect((await store.getUser(created.id))?.googleSubject).toBe(identity.subject);
      expect(await store.listUsers()).toHaveLength(1);
    });
  });

  it("follows the google account when its email changes", async () => {
    await withStore(async (auth, store) => {
      const first = await auth.loginWithGoogle(identity, true);
      const { user } = await auth.loginWithGoogle({ ...identity, email: "renamed@example.org" }, false);
      expect(user.id).toBe(first.user.id);
      expect(await store.listUsers()).toHaveLength(1);
    });
  });

  it("issues a session that authenticates and can be revoked", async () => {
    await withStore(async (auth) => {
      const { token, user } = await auth.loginWithGoogle(identity, true);
      expect(await auth.authenticate(token)).toMatchObject({ id: user.id });
      auth.logout(token);
      expect(await auth.authenticate(token)).toBeUndefined();
    });
  });
});
