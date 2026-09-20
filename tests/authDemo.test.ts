import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store/jsonStore.js";

it.each(["1", "true"])("demo mode %s exposes the frontend session check without an account", async (value) => {
  vi.stubEnv("PERISCOPE_AUTH_DISABLED", value);
  const temp = await mkdtemp(path.join(os.tmpdir(), "periscope-demo-auth-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ store: new JsonStore(path.join(temp, "store.json")) });
    const session = await app.inject({ method: "GET", url: "/api/auth/me", headers: { origin: "http://localhost:3001" } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ user: null });
    expect(session.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(200);
  } finally {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
