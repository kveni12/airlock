import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { accessForFile } from "../src/repo/runFiles.js";
import { listRepoDirectory } from "../src/repo/repoTree.js";

it("shows inherited access, specific denials, last duplicate rule, and planner downgrade", () => {
  const permissions = { filesystem: [{ path: "/workspace", access: "read" as const }, { path: "src", access: "read_write" as const }, { path: "src/private", access: "none" as const }] };
  expect(accessForFile("package.json", permissions)).toBe("read");
  expect(accessForFile("src/main.ts", permissions)).toBe("read_write");
  expect(accessForFile("src/private/key", permissions)).toBe("none");
  expect(accessForFile("src-other/main.ts", permissions)).toBe("read");
  expect(accessForFile("src/main.ts", permissions, true)).toBe("read");
  expect(accessForFile("src/main.ts", { filesystem: [...permissions.filesystem, { path: "src", access: "read" }] })).toBe("read");
});

it("lists files but refuses traversal and escaping directory symlinks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "periscope-tree-"));
  try {
    await mkdir(path.join(temp, "repo"));
    await writeFile(path.join(temp, "repo", "a.txt"), "hello");
    await symlink(temp, path.join(temp, "repo", "outside"));
    expect((await listRepoDirectory(path.join(temp, "repo"))).entries.map((e) => e.name)).toEqual(["a.txt"]);
    await expect(listRepoDirectory(path.join(temp, "repo"), "../")).rejects.toThrow();
    await expect(listRepoDirectory(path.join(temp, "repo"), "outside")).rejects.toThrow();
  } finally { await rm(temp, { recursive: true, force: true }); }
});
