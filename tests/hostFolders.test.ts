import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHostFolders } from "../src/repo/hostFolders.js";

describe("host folder listing", () => {
  let temp: string;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "periscope-folders-"));
    await mkdir(path.join(temp, "repo-a", ".git"), { recursive: true });
    await mkdir(path.join(temp, "plain"), { recursive: true });
    await mkdir(path.join(temp, ".hidden"), { recursive: true });
    await mkdir(path.join(temp, "node_modules"), { recursive: true });
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  it("lists only visible sub-folders, marks git repositories and exposes the parent", async () => {
    const listing = await listHostFolders(temp);
    expect(listing.dir).toBe(path.resolve(temp));
    expect(listing.parent).toBe(path.dirname(path.resolve(temp)));
    expect(listing.entries.map((e) => [e.name, e.isGitRepo])).toEqual([["plain", false], ["repo-a", true]]);
    expect(listing.isGitRepo).toBe(false);
    expect((await listHostFolders(path.join(temp, "repo-a"))).isGitRepo).toBe(true);
  });

  it("defaults to the home directory", async () => {
    expect((await listHostFolders()).dir).toBe(os.homedir());
  });
});
