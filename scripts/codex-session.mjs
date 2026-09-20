export function codexSession(auth = "chatgpt") {
  if (!["chatgpt", "api-key"].includes(auth)) throw new Error("PERISCOPE_CODEX_AUTH must be chatgpt or api-key");
  const check = 'command -v codex >/dev/null || { echo "Codex is missing from this image; run npm run docker:build."; exit 127; }';
  return {
    auth,
    requiredHosts: auth === "chatgpt" ? ["auth.openai.com", "chatgpt.com"] : ["api.openai.com"],
    // Run this directly in the terminal, outside the transcript recorder.
    login: [check, ...(auth === "chatgpt" ? [
      "unset OPENAI_API_KEY",
      'codex -c cli_auth_credentials_store=\'"file"\' login status >/dev/null 2>&1 && exit 0',
      'exec codex -c cli_auth_credentials_store=\'"file"\' login --device-auth'
    ] : [
      'test -n "${OPENAI_API_KEY:-}" || { echo "Grant OPENAI_API_KEY and set it on the backend for explicit api-key mode."; exit 1; }',
      'printenv OPENAI_API_KEY | codex -c cli_auth_credentials_store=\'"file"\' login --with-api-key'
    ])].join("\n"),
    launch: [auth === "chatgpt" ? "unset OPENAI_API_KEY" : ":", 'exec codex -c cli_auth_credentials_store=\'"file"\' --dangerously-bypass-approvals-and-sandbox'].join("\n")
  };
}
