import { localAgent } from "../shared/local-agents.mjs";
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"];
export function claudeSettings() {
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: "python3 /tmp/periscope-claude-hook.py", timeout: 5 }] }]])) };
}
export function claudeSession(auth = "account") {
  if (!["account", "api-key"].includes(auth)) throw new Error("PERISCOPE_CLAUDE_AUTH must be account or api-key");
  const check = 'command -v claude >/dev/null || { echo "Claude Code is missing; run npm run docker:build."; exit 127; }';
  const environment = [
    "unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY",
    ...(auth === "account" ? ["unset ANTHROPIC_API_KEY"] : []),
    "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 ENABLE_CLAUDEAI_MCP_SERVERS=false"
  ];
  return {
    auth,
    requiredHosts: auth === "account" ? localAgent("claude_code").hosts : ["api.anthropic.com"],
    login: [check, ...environment, auth === "account" ? "exec claude auth login --claudeai" : 'test -n "${ANTHROPIC_API_KEY:-}" || { echo "Explicit API-key mode requires an ANTHROPIC_API_KEY project grant and backend value."; exit 1; }'].join("\n"),
    launch: [...environment, "exec claude --permission-mode default --settings /tmp/periscope-claude-settings.json"].join("\n")
  };
}
