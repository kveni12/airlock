import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PublicUser, User, UserRole } from "../types.js";
import type { GoogleIdentity } from "./googleOAuth.js";
import { JsonStore } from "../store/jsonStore.js";
import { createId } from "../utils/id.js";
import { assertUsablePassword, hashPassword, normalizeEmail, verifyPassword } from "./password.js";

export const SESSION_COOKIE = "periscope_session";

export interface AuthServiceOptions {
  /** How long a session stays valid after login. */
  sessionTtlMs?: number;
}

interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

export interface CreateUserInput {
  email: unknown;
  password: unknown;
  displayName?: unknown;
  role?: UserRole;
}

/**
 * Operator accounts and session tokens.
 *
 * Sessions are kept in memory: a backend restart signs everyone out, which is the right
 * trade-off for a local governance tool and keeps session tokens out of the JSON store.
 */
export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTtlMs: number;
  private setupToken?: string;

  constructor(private readonly store: JsonStore, options: AuthServiceOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  }

  async needsBootstrap(): Promise<boolean> {
    return (await this.store.listUsers()).length === 0;
  }

  /**
   * Issues the one-time token that authorizes creating the first admin. Printing it to the
   * server log means whoever can read the log owns the instance, rather than whoever reaches
   * the port first.
   */
  async issueSetupToken(): Promise<string | undefined> {
    if (!(await this.needsBootstrap())) return undefined;
    this.setupToken ??= randomBytes(24).toString("hex");
    return this.setupToken;
  }

  async bootstrap(input: CreateUserInput & { setupToken?: unknown }): Promise<PublicUser> {
    if (!(await this.needsBootstrap())) throw new Error("Periscope already has an administrator");
    const expected = await this.issueSetupToken();
    if (!expected || typeof input.setupToken !== "string" || !safeEqual(input.setupToken, expected)) {
      throw new Error("Invalid setup token. It is printed in the backend log at startup.");
    }
    const user = await this.createUser({ ...input, role: "admin" });
    this.setupToken = undefined;
    return user;
  }

  async createUser(input: CreateUserInput): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const password = assertUsablePassword(input.password);
    const displayName = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : email;
    const { salt, passwordHash } = await hashPassword(password);
    const user: User = {
      id: createId("usr"),
      email,
      displayName,
      role: input.role ?? "operator",
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    await this.store.createUser(user);
    return toPublicUser(user);
  }

  async login(email: unknown, password: unknown): Promise<{ user: PublicUser; token: string; expiresAt: number }> {
    const user = typeof email === "string" ? await this.store.getUserByEmail(email.trim().toLowerCase()) : undefined;
    const valid = user && typeof password === "string" ? await verifyPassword(password, user) : false;
    if (!user || !valid) throw new Error("Invalid email or password");
    return this.issueSession(user);
  }

  /**
   * Signs in a verified Google identity. An existing account is matched by Google subject first and
   * email second, so changing the display name or re-creating the local account keeps working;
   * `allowProvision` decides whether an unknown address may create an operator account.
   */
  async loginWithGoogle(
    identity: GoogleIdentity,
    allowProvision: boolean
  ): Promise<{ user: PublicUser; token: string; expiresAt: number }> {
    const users = await this.store.listUsers();
    const existing = users.find((candidate) => candidate.googleSubject === identity.subject)
      ?? users.find((candidate) => candidate.email === identity.email);

    if (existing) {
      const linked = existing.googleSubject === identity.subject
        ? existing
        : (await this.store.updateUser(existing.id, { googleSubject: identity.subject })) ?? existing;
      return this.issueSession(linked);
    }

    if (!allowProvision) throw new Error(`${identity.email} is not allowed to sign in to this instance`);

    const user: User = {
      id: createId("usr"),
      email: identity.email,
      displayName: identity.displayName,
      role: "operator",
      googleSubject: identity.subject,
      createdAt: new Date().toISOString()
    };
    await this.store.createUser(user);
    return this.issueSession(user);
  }

  private async issueSession(user: User): Promise<{ user: PublicUser; token: string; expiresAt: number }> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.sessions.set(token, { token, userId: user.id, expiresAt });
    const updated = await this.store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    return { user: toPublicUser(updated ?? user), token, expiresAt };
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  async authenticate(token: string | undefined): Promise<PublicUser | undefined> {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    const user = await this.store.getUser(session.userId);
    if (!user) {
      this.sessions.delete(token);
      return undefined;
    }
    return toPublicUser(user);
  }

  async listUsers(): Promise<PublicUser[]> {
    return (await this.store.listUsers()).map(toPublicUser);
  }

  get cookieMaxAgeSeconds(): number {
    return Math.floor(this.sessionTtlMs / 1000);
  }
}

export function toPublicUser(user: User): PublicUser {
  const { salt: _salt, passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
