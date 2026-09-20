import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceAudit, validateLocalScope } from "../src/runtime/localWorkspace.js";
import { ensureGitBaseline } from "../src/telemetry/gitTelemetry.js";

const exec = promisify(execFile);
let temp: string;
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

describe("live local workspace", () => {
  it("records only session changes, including ignored additions, without altering local Git state", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "local-workspace-test-"));
    await writeFile(path.join(temp, "existing.txt"), "committed\n");
    await writeFile(path.join(temp, ".gitignore"), "ignored.txt\n");
    await ensureGitBaseline(temp);
    await writeFile(path.join(temp, "existing.txt"), "already dirty\n");
    await exec("git", ["add", "existing.txt"], { cwd: temp });
    const index = await readFile(path.join(temp, ".git/index"));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: temp })).stdout;
    const audit = await LocalWorkspaceAudit.create(temp);
    try {
      await writeFile(path.join(temp, "existing.txt"), "session edit\n");
      await writeFile(path.join(temp, "ignored.txt"), "new during session\n");
      const result = await audit.finish();
      expect(result.files).toEqual(["existing.txt", "ignored.txt"]);
      expect(result.diff).toContain("-already dirty");
      expect(result.diff).not.toContain("-committed");
      expect(await readFile(path.join(temp, ".git/index"))).toEqual(index);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: temp })).stdout).toBe(head);
    } finally { await audit.dispose(); }
    expect(await readFile(path.join(temp, "existing.txt"), "utf8")).toBe("session edit\n");
  });

  it("rejects ambiguous grants and host escapes before mounting a local project", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "local-scope-test-"));
    await mkdir(path.join(temp, "src"));
    const allowed = [{ path: "/workspace", access: "read" as const }, { path: "src", access: "read_write" as const }];
    await expect(validateLocalScope(temp, { filesystem: allowed })).resolves.toBeUndefined();
    await expect(validateLocalScope(temp, {})).rejects.toThrow(/explicit/);
    for (const grant of ["/workspace", "../escape", "src/**", ".git", "missing"]) {
      await expect(validateLocalScope(temp, { filesystem: [{ path: grant, access: "read_write" }] })).rejects.toThrow();
    }
    await expect(validateLocalScope(temp, { filesystem: [...allowed, { path: "src/private", access: "read" }] })).rejects.toThrow(/read-only child/);
    await symlink(os.tmpdir(), path.join(temp, "external"));
    await expect(validateLocalScope(temp, { filesystem: [{ path: "external", access: "read_write" }] })).rejects.toThrow(/inside the project/);
  });
});
