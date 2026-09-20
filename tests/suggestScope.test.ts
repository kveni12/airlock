import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { suggestScope } from "../src/projects/suggestScope.js";
import { RequestAnalyzer } from "../src/request/requestAnalyzer.js";

it("turns explicit task folders into grants, preserves prohibitions, and leaves ambiguity read-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "periscope-suggest-"));
  try {
    for (const dir of ["src", "tests", "infra", "src/private"]) await mkdir(path.join(root, dir), { recursive: true });
    const suggest = (rawPrompt: string) => suggestScope(root, new RequestAnalyzer().analyze({ id: "r", taskId: "t", rawPrompt, createdAt: new Date().toISOString() }));
    const result = await suggest("Fix src. Add tests in tests. Do not change infra.");
    expect(result.scope.folders).toContainEqual({ path: "/workspace/src", access: "read_write" });
    expect(result.scope.folders).toContainEqual({ path: "/workspace/tests", access: "read_write" });
    expect(result.scope.folders.some((f) => f.path.includes("infra") && f.access === "read_write")).toBe(false);
    expect((await suggest("Fix src. Do not change src/private.")).scope.folders).toEqual([{ path: "/workspace", access: "read" }]);
    expect((await suggest("Improve things.")).scope.folders).toHaveLength(1);
    expect((await suggest("Read src only.")).scope.folders).toHaveLength(1);
    expect(result.scope.secrets).toEqual([]);
    const claude = await suggestScope(root, new RequestAnalyzer().analyze({ id: "r", taskId: "t", rawPrompt: "Fix src.", createdAt: new Date().toISOString() }), "claude_code");
    expect(claude.scope.hosts).toEqual(["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com"]);
    expect(claude.scope.secrets).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
