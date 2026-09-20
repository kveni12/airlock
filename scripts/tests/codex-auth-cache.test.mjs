import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexAuthCache } from "../codex-auth-cache.mjs";

test("persists only auth, locks concurrent sessions, and atomically retains refreshed credentials", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "periscope-auth-test-"));
  let cache;
  let credential = "synthetic-login";
  const docker = (args, stdio) => {
    if (stdio && typeof stdio[1] === "number") writeFileSync(stdio[1], credential);
    else if (stdio && typeof stdio[0] === "number") assert.equal(readFileSync(stdio[0], "utf8"), credential);
  };
  try {
    cache = codexAuthCache(dir, docker);
    assert.equal(cache.restore("container"), false);
    assert.throws(() => codexAuthCache(dir, docker), /Another persistent/);
    assert.equal(cache.save("container"), true);
    assert.equal(statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    cache.release();
    cache = codexAuthCache(dir, docker);
    assert.equal(cache.restore("container"), true);
    credential = "synthetic-refreshed-login";
    assert.equal(cache.save("container"), true);
    cache.release();
    cache = codexAuthCache(dir, () => { throw new Error("container stopped"); });
    assert.equal(cache.save("container"), false);
    assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), credential);
    rmSync(path.join(dir, "auth.json"));
    symlinkSync("/dev/null", path.join(dir, "auth.json"));
    assert.throws(() => cache.restore("container"), /Invalid/);
  } finally { cache?.release(); rmSync(dir, { recursive: true, force: true }); }
});
