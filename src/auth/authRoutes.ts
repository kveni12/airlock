import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PublicUser } from "../types.js";
import { AuthService, SESSION_COOKIE } from "./authService.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: PublicUser;
  }
}

/** Reachable without a session: everything else requires one. */
const PUBLIC_PATHS = new Set(["/health", "/api/auth/status", "/api/auth/bootstrap", "/api/auth/login", "/api/auth/logout"]);

export interface AuthPluginOptions {
  allowedOrigins: string[];
  cookieSecure: boolean;
}

/** `PERISCOPE_AUTH_DISABLED=1` turns login off (local/demo use): every caller is anonymous, decisions record no account. */
export function authDisabled(): boolean {
  return process.env.PERISCOPE_AUTH_DISABLED === "1" || process.env.PERISCOPE_AUTH_DISABLED === "true";
}

export async function registerAuth(app: FastifyInstance, auth: AuthService, options: AuthPluginOptions): Promise<void> {
  await app.register(cookie);
  if (authDisabled()) app.log.warn("PERISCOPE_AUTH_DISABLED is set: login is off and governance actions are not attributed to an account");

  app.addHook("onRequest", async (request, reply) => {
    if (authDisabled()) return;
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
    needsBootstrap: await auth.needsBootstrap()
  }));

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
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: options.cookieSecure,
    maxAge: auth.cookieMaxAgeSeconds
  });
  return user;
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
