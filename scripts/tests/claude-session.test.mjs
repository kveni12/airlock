import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeSession, claudeSettings } from "../claude-session.mjs";

test("Claude account launch strips inherited credentials and retains approval prompts", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "periscope-claude-test-"));
  try {
    await writeFile(path.join(temp, "claude"), '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$*" "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" "${CLAUDE_CODE_OAUTH_TOKEN-unset}" >> "$AUTH_TEST_LOG"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${temp}:${process.env.PATH}`, ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_AUTH_TOKEN: "fake-token", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth", AUTH_TEST_LOG: path.join(temp, "calls") };
    const plan = claudeSession();
    assert.equal(spawnSync("bash", ["-c", plan.login], { env }).status, 0);
    assert.equal(spawnSync("bash", ["-c", plan.launch], { env }).status, 0);
    assert.equal(await readFile(env.AUTH_TEST_LOG, "utf8"), "auth login --claudeai|unset|unset|unset\n--permission-mode default --settings /tmp/periscope-claude-settings.json|unset|unset|unset\n");
    assert.ok(plan.requiredHosts.includes("platform.claude.com"));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("Claude hooks are observational and API-key mode is explicit", () => {
  const hooks = claudeSettings().hooks;
  for (const name of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "PermissionRequest"]) assert.equal(hooks[name][0].hooks[0].command, "python3 /tmp/periscope-claude-hook.py");
  assert.equal(claudeSession("api-key").auth, "api-key");
  assert.throws(() => claudeSession("automatic"));
  assert.doesNotMatch(claudeSession().launch, /dangerously|bypass/);
});
