import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexSession } from "../codex-session.mjs";

test("account mode logs in with a device code and never passes an inherited API key", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "periscope-account-test-"));
  try {
    await writeFile(path.join(temp, "codex"), '#!/bin/sh\nprintf "%s|%s\\n" "$*" "${OPENAI_API_KEY-unset}" >> "$AUTH_TEST_LOG"\ncase "$*" in *"login status") exit "${AUTH_TEST_STATUS:-1}";; esac\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENAI_API_KEY: "dummy-not-a-real-key", AUTH_TEST_LOG: path.join(temp, "calls") };
    const plan = codexSession();
    assert.equal(spawnSync("bash", ["-c", plan.login], { env }).status, 0);
    assert.equal(spawnSync("bash", ["-c", plan.launch], { env }).status, 0);
    assert.equal(await readFile(env.AUTH_TEST_LOG, "utf8"), '-c cli_auth_credentials_store="file" login status|unset\n-c cli_auth_credentials_store="file" login --device-auth|unset\n-c cli_auth_credentials_store="file" --dangerously-bypass-approvals-and-sandbox|unset\n');
    await writeFile(env.AUTH_TEST_LOG, "");
    assert.equal(spawnSync("bash", ["-c", plan.login], { env: { ...env, AUTH_TEST_STATUS: "0" } }).status, 0);
    assert.equal(await readFile(env.AUTH_TEST_LOG, "utf8"), '-c cli_auth_credentials_store="file" login status|unset\n');
    assert.deepEqual(plan.requiredHosts, ["auth.openai.com", "chatgpt.com"]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("API-key mode must be explicit and unknown authentication modes fail", () => {
  assert.equal(codexSession("api-key").auth, "api-key");
  assert.match(codexSession("api-key").login, /--with-api-key/);
  assert.throws(() => codexSession("automatic"), /must be/);
});
