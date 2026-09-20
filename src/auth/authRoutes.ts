import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PublicUser } from "../types.js";
import { AuthService, SESSION_COOKIE } from "./authService.js";
import {
  GoogleAuthorizationStore,
  exchangeCodeForIdentity,
  mayProvision,
  safeReturnPath,
  type GoogleOAuthConfig
} from "./googleOAuth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: PublicUser;
  }
}

/** Reachable without a session: everything else requires one. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/api/auth/status",
  "/api/auth/bootstrap",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/google/start",
  "/api/auth/google/callback"
]);

export interface AuthPluginOptions {
  allowedOrigins: string[];
  cookieSecure: boolean;
  /** Google sign-in is offered only when an OAuth client is configured. */
  google?: GoogleOAuthConfig;
}

export async function registerAuth(app: FastifyInstance, auth: AuthService, options: AuthPluginOptions): Promise<void> {
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (PUBLIC_PATHS.has(path)) return;

    if (request.method !== "GET" && request.method !== "HEAD" && !originAllowed(request, options.allowedOrigins)) {
      return reply.code(403).send({ error: "Request origin is not allowed" });
    }

    const user = await auth.authenticate(request.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    request.user = user;
  });

  app.get("/api/auth/status", async () => ({
    authenticated: false,
    needsBootstrap: await auth.needsBootstrap(),
    googleEnabled: Boolean(options.google)
  }));

  const pendingGoogleAuthorizations = new GoogleAuthorizationStore();

  app.get("/api/auth/google/start", async (request, reply) => {
    const google = options.google;
    if (!google) return reply.code(404).send({ error: "Google sign-in is not configured" });
    const returnTo = safeReturnPath((request.query as Record<string, unknown> | undefined)?.returnTo);
    const { url } = pendingGoogleAuthorizations.start(google, returnTo);
    return reply.redirect(url);
  });

  app.get("/api/auth/google/callback", async (request, reply) => {
    const google = options.google;
    if (!google) return reply.code(404).send({ error: "Google sign-in is not configured" });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const pending = pendingGoogleAuthorizations.claim(typeof query.state === "string" ? query.state : undefined);
    if (!pending) return reply.code(400).send({ error: "This sign-in link has expired. Start again." });
    if (typeof query.code !== "string") {
      return reply.redirect(`${pending.returnTo}?authError=${encodeURIComponent("Google sign-in was cancelled")}`);
    }

    try {
      const identity = await exchangeCodeForIdentity(google, query.code, pending.codeVerifier);
      const { user, token } = await auth.loginWithGoogle(identity, mayProvision(identity.email, google));
      setSessionCookie(reply, auth, options, token);
      request.log.info({ email: user.email }, "Google sign-in");
      return reply.redirect(pending.returnTo);
    } catch (error: unknown) {
      return reply.redirect(`${pending.returnTo}?authError=${encodeURIComponent(errorMessage(error))}`);
    }
  });

  app.post("/api/auth/bootstrap", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const user = await auth.bootstrap({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        setupToken: body.setupToken
      });
      await establishSession(auth, reply, options, body.email, body.password);
      return reply.code(201).send({ user });
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) {
      return reply.code(403).send({ error: "Request origin is not allowed" });
    }
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const user = await establishSession(auth, reply, options, body.email, body.password);
      return { user };
    } catch (error: unknown) {
      return reply.code(401).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ user: request.user }));

  app.get("/api/auth/users", async (request, reply) => {
    if (request.user?.role !== "admin") return reply.code(403).send({ error: "Administrator role required" });
    return { users: await auth.listUsers() };
  });

  app.post("/api/auth/users", async (request, reply) => {
    if (request.user?.role !== "admin") return reply.code(403).send({ error: "Administrator role required" });
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const user = await auth.createUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        role: body.role === "admin" ? "admin" : "operator"
      });
      return reply.code(201).send({ user });
    } catch (error: unknown) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

async function establishSession(
  auth: AuthService,
  reply: FastifyReply,
  options: AuthPluginOptions,
  email: unknown,
  password: unknown
): Promise<PublicUser> {
  const { user, token } = await auth.login(email, password);
  setSessionCookie(reply, auth, options, token);
  return user;
}

function setSessionCookie(reply: FastifyReply, auth: AuthService, options: AuthPluginOptions, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: options.cookieSecure,
    maxAge: auth.cookieMaxAgeSeconds
  });
}

/**
 * Same-site cookies keep a browser on another site from driving the API, but a `lax` cookie is
 * still sent on top-level cross-site navigation, so state-changing requests also assert origin.
 * Non-browser clients (curl, tests) send no Origin header and are accepted.
 */
function originAllowed(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
