import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { corsHeadersFor, createApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { TEST_OPERATOR, signIn } from "./testAuth.js";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.passwordHash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
  });

  it("salts each hash independently", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-123"), hashPassword("same-password-123")]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });
});

describe("hijacked SSE responses", () => {
  const allowed = ["http://localhost:3001"];

  it("echo an allowed browser origin so a credentialed EventSource can read the stream", () => {
    expect(corsHeadersFor("http://localhost:3001", allowed)).toEqual({
      "Access-Control-Allow-Origin": "http://localhost:3001",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin"
    });
  });

  it("send no CORS headers for a disallowed or absent origin", () => {
    expect(corsHeadersFor("http://evil.example", allowed)).toEqual({});
    expect(corsHeadersFor(undefined, allowed)).toEqual({});
  });
});

describe("authentication", () => {
  let temp: string;
  let app: FastifyInstance;
  let auth: AuthService;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "agentguard-auth-"));
    const store = new JsonStore(path.join(temp, "store.json"));
    auth = new AuthService(store);
    app = await createApp({ store, auth });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });

  it("reports that the instance needs bootstrapping and leaves /health open", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({
      authenticated: false,
      needsBootstrap: true,
      googleEnabled: false
    });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("reports google sign-in as unavailable and refuses to start it when unconfigured", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json().googleEnabled).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/auth/google/start" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/auth/google/callback?code=x&state=y" })).statusCode).toBe(404);
  });

  it("refuses to bootstrap without the setup token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { ...TEST_OPERATOR, setupToken: "wrong" }
    });
    expect(response.statusCode).toBe(400);
    expect(await auth.needsBootstrap()).toBe(true);
  });

  it("rejects a second bootstrap once an administrator exists", async () => {
    await signIn(app, auth);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { email: "other@example.com", password: "another-long-password", setupToken: "anything" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires a session for API routes", async () => {
    await signIn(app, auth);
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(401);
  });

  it("logs in, identifies the operator, and logs out", async () => {
    await signIn(app, auth);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: TEST_OPERATOR });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((item) => item.name === "periscope_session");
    expect(cookie?.httpOnly).toBe(true);
    const header = `${cookie?.name}=${cookie?.value}`;

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: header } });
    expect(me.json().user).toMatchObject({ email: TEST_OPERATOR.email, role: "admin" });
    expect(me.json().user).not.toHaveProperty("passwordHash");
    expect((await app.inject({ method: "GET", url: "/api/runs", headers: { cookie: header } })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: header } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: header } })).statusCode).toBe(401);
  });

  it("rejects a wrong password without leaking whether the account exists", async () => {
    await signIn(app, auth);
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: TEST_OPERATOR.email, password: "not-the-password" }
    });
    const unknownUser = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "not-the-password" }
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().error).toBe(unknownUser.json().error);
  });

  it("rejects short passwords and malformed emails", async () => {
    await expect(auth.createUser({ email: "someone@example.com", password: "short" })).rejects.toThrow(/at least/);
    await expect(auth.createUser({ email: "not-an-email", password: "long-enough-password" })).rejects.toThrow(/valid email/);
  });

  it("rejects state-changing requests from an unlisted origin", async () => {
    const cookie = await signIn(app, auth);
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie, origin: "https://evil.example" },
      payload: { taskId: "t1", rawPrompt: "do something" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("attributes a request to the authenticated operator", async () => {
    const cookie = await signIn(app, auth);
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { cookie },
      payload: { taskId: "t1", rawPrompt: "Fix the login bug", createdBy: "someone-else" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request.createdBy).toBe(`Test Operator <${TEST_OPERATOR.email}>`);
  });

  it("only lets an administrator create further operators", async () => {
    const adminCookie = await signIn(app, auth);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/users",
      headers: { cookie: adminCookie },
      payload: { email: "member@example.com", password: "member-long-password", displayName: "Member" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.role).toBe("operator");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "member@example.com", password: "member-long-password" }
    });
    const memberCookie = login.cookies.find((item) => item.name === "periscope_session");
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/auth/users",
      headers: { cookie: `${memberCookie?.name}=${memberCookie?.value}` },
      payload: { email: "third@example.com", password: "third-long-password" }
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
