import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRepoDirectory } from "../src/repo/repoTree.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "periscope-tree-"));
  await mkdir(path.join(root, "src/auth"), { recursive: true });
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "hi");
  await writeFile(path.join(root, "src/auth/session.ts"), "");
  return root;
}

describe("listRepoDirectory", () => {
  it("lists directories before files and hides .git / node_modules", async () => {
    const root = await fixture();
    const listing = await listRepoDirectory(root);
    expect(listing.dir).toBe("");
    expect(listing.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:src", "file:README.md"]);
  });

  it("lists nested directories with repo-relative paths", async () => {
    const root = await fixture();
    const listing = await listRepoDirectory(root, "src/auth");
    expect(listing.dir).toBe("src/auth");
    expect(listing.entries).toEqual([{ name: "session.ts", path: "src/auth/session.ts", kind: "file" }]);
  });

  it("refuses to leave the repository root", async () => {
    const root = await fixture();
    await expect(listRepoDirectory(root, "../")).rejects.toThrow(/inside the repository/);
  });
});
