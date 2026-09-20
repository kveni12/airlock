import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { dockerBinds } from "../src/runtime/dockerProvider.js";
import { limaMountSpec } from "../src/runtime/limaProvider.js";
import { baseHostEnvironment } from "../src/runtime/processProvider.js";
import { resolveSecretEnvironment } from "../src/runtime/runtimeManager.js";
import { detectPreventedWrite } from "../src/telemetry/agentOutputMonitor.js";
import { planWorkspaceMounts, relativeGrantPath } from "../src/runtime/sandboxProvider.js";
import { NetworkProxy } from "../src/telemetry/networkProxy.js";
import type { EventCollector } from "../src/events/eventCollector.js";
import type { RunRecord } from "../src/types.js";

const run = { id: "run_1", taskId: "t", agentId: "a", workspaceAccess: "read_write" } as RunRecord;

describe("workspace mount plan", () => {
  let directory: string;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("normalises grant paths and widens globs to their directory", () => {
    expect(relativeGrantPath("/workspace/src/auth/")).toBe("src/auth");
    expect(relativeGrantPath("./tests/auth")).toBe("tests/auth");
    expect(relativeGrantPath("src/**")).toBe("src");
    expect(relativeGrantPath("src/*.ts")).toBe("src");
    expect(relativeGrantPath("/workspace")).toBe("");
    expect(relativeGrantPath("**")).toBe("");
  });

  it("mounts the root read-only and overlays only read_write grants", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
    const mounts = await planWorkspaceMounts(run, directory, {
      filesystem: [
        { path: "/workspace", access: "read" },
        { path: "/workspace/src/auth", access: "read_write" },
        { path: "/workspace/src/auth/session", access: "read_write" },
        { path: "/workspace/tests", access: "read_write" },
        { path: "/workspace/infra", access: "read" }
      ]
    });
    expect(mounts).toEqual({ root: "ro", readonly: [], writable: ["src/auth", "tests"], maskedFiles: [], maskedDirectories: [] });
    await expect(stat(path.join(directory, "src/auth"))).resolves.toBeTruthy();
  });

  it("is fully read-only for planners and fully writable when the root is granted or no scope exists", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
    const empty = { readonly: [], writable: [], maskedFiles: [], maskedDirectories: [] };
    expect(await planWorkspaceMounts({ ...run, workspaceAccess: "read_only" }, directory, { filesystem: [{ path: "/workspace", access: "read_write" }] })).toEqual({ root: "ro", ...empty });
    expect(await planWorkspaceMounts(run, directory, { filesystem: [{ path: "/workspace", access: "read_write" }] })).toEqual({ root: "rw", ...empty });
    expect(await planWorkspaceMounts(run, directory, {})).toEqual({ root: "rw", ...empty });
  });

  it("can hide the whole repo while exposing only a writable child", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
    const permissions = {
      filesystem: [
        { path: "/workspace", access: "none" as const },
        { path: "/workspace/src/auth", access: "read_write" as const }
      ]
    };
    expect(await planWorkspaceMounts(run, directory, permissions)).toEqual({
      root: "none",
      readonly: [],
      writable: ["src/auth"],
      maskedFiles: [],
      maskedDirectories: []
    });
    expect(await planWorkspaceMounts({ ...run, workspaceAccess: "read_only" }, directory, permissions)).toEqual({
      root: "none",
      readonly: ["src/auth"],
      writable: [],
      maskedFiles: [],
      maskedDirectories: []
    });
  });

  it("masks a denied folder while allowing a more specific child override", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
    await mkdir(path.join(directory, "private/public"), { recursive: true });
    const mounts = await planWorkspaceMounts(run, directory, {
      filesystem: [
        { path: "/workspace", access: "read" },
        { path: "/workspace/private", access: "none" },
        { path: "/workspace/private/public", access: "read_write" }
      ]
    });
    expect(mounts).toEqual({
      root: "ro",
      readonly: [],
      writable: ["private/public"],
      maskedFiles: [],
      maskedDirectories: ["private"]
    });
  });

  it("refuses grants that escape the workspace", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
    await expect(planWorkspaceMounts(run, directory, { filesystem: [{ path: "../../etc", access: "read_write" }] })).rejects.toThrow(/escapes/);
  });
});

describe("process runtime environment", () => {
  it("does not leak host secrets into the agent process", () => {
    const env = baseHostEnvironment({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "aws" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x" });
  });

  it("injects only the secrets the human granted", () => {
    const host = { OPENAI_API_KEY: "granted", ANTHROPIC_API_KEY: "not-granted", MISSING: undefined };
    expect(resolveSecretEnvironment({ secrets: ["OPENAI_API_KEY", "MISSING"] }, host)).toEqual({ OPENAI_API_KEY: "granted" });
    expect(resolveSecretEnvironment({}, host)).toEqual({});
  });
});

describe("provider mounts", () => {
  it("docker binds only visible paths and preserves nested access overrides", () => {
    const emptyMasks = { maskedFiles: [], maskedDirectories: [] };
    expect(dockerBinds("/tmp/ws", { root: "ro", readonly: [], writable: ["src/auth", "tests"], ...emptyMasks })).toEqual([
      "/tmp/ws:/workspace:ro",
      "/tmp/ws/src/auth:/workspace/src/auth",
      "/tmp/ws/tests:/workspace/tests"
    ]);
    expect(dockerBinds("/tmp/ws", { root: "rw", readonly: ["infra"], writable: [], ...emptyMasks })).toEqual([
      "/tmp/ws:/workspace",
      "/tmp/ws/infra:/workspace/infra:ro"
    ]);
    expect(dockerBinds("/tmp/ws", { root: "none", readonly: ["docs"], writable: ["src/auth"], ...emptyMasks })).toEqual([
      "/tmp/ws/docs:/workspace/docs:ro",
      "/tmp/ws/src/auth:/workspace/src/auth"
    ]);
  });

  it("lima can only express whole-workspace ro/rw, never a partial overlay", () => {
    const empty = { readonly: [], writable: [], maskedFiles: [], maskedDirectories: [] };
    expect(limaMountSpec("/tmp/ws", { root: "ro", ...empty })).toBe("/tmp/ws");
    expect(limaMountSpec("/tmp/ws", { root: "rw", ...empty })).toBe("/tmp/ws:w");
    expect(limaMountSpec("/tmp/ws", { root: "ro", ...empty, writable: ["src"] })).toBe("/tmp/ws:w");
    expect(limaMountSpec("/tmp/ws", { root: "none", ...empty, readonly: ["src"] })).toBe("/tmp/ws");
  });
});

describe("prevented write detection", () => {
  it("recognises kernel read-only refusals in agent output", () => {
    expect(detectPreventedWrite("sh: 6: cannot create infra/prod.tf: Read-only file system")).toEqual({ path: "/workspace/infra/prod.tf" });
    expect(detectPreventedWrite("touch: cannot touch 'newroot': Read-only file system")).toEqual({ path: "/workspace/newroot" });
    expect(detectPreventedWrite("Error: EROFS: read-only file system, open '/workspace/package.json'")).toEqual({});
    expect(detectPreventedWrite("wrote src/auth/session.js")).toBeUndefined();
  });
});

describe("network proxy", () => {
  it("denies every host when the allowlist is empty", async () => {
    const emitted: unknown[] = [];
    const events = { emitEvent: vi.fn(async (event: unknown) => { emitted.push(event); }) } as unknown as EventCollector;
    const proxy = new NetworkProxy(run, [], events);
    const port = await proxy.start();
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "http://example.com/" }, (response) => resolve(response.statusCode ?? 0)).on("error", reject);
    });
    await proxy.stop();
    expect(status).toBe(403);
    expect(emitted).toEqual([expect.objectContaining({ category: "network", action: "blocked", resource: "example.com", allowed: false })]);
  });

  it("refuses HTTPS CONNECT for hosts off the allowlist and tunnels allowed ones", async () => {
    const upstream = net.createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const events = { emitEvent: vi.fn(async () => undefined) } as unknown as EventCollector;
    const proxy = new NetworkProxy(run, ["127.0.0.1"], events);
    const port = await proxy.start();

    const connect = (target: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });

    expect(await connect("registry.npmjs.org:443")).toMatch(/^HTTP\/1.1 403/);
    expect(await connect(`127.0.0.1:${upstreamPort}`)).toMatch(/^HTTP\/1.1 200 Connection Established\r\n\r\nhello/);
    expect(events.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "blocked", resource: "registry.npmjs.org" }));
    expect(events.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "request", resource: "127.0.0.1", allowed: true }));

    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
