# Project-first terminal workflow

1. Open **Projects → New project**. Choose a local folder, name the project, and select Codex or Claude Code.
2. Describe the task, for example: `Fix src. Add tests in tests. Do not change infra.`
3. Click **Suggest permissions from description**. The existing deterministic
   human-intent analyzer extracts objectives and constraints; folder matching
   suggests edits only for explicitly named existing directories. Review the
   folder permissions and allowed hosts, adjust them, and save.
4. The project page shows the launch command. In that folder run the displayed `periscope codex --project …` or
   `periscope claude --project …` command. Sign in with your agent account.
   The saved description becomes the initial agent prompt and is recorded as a human-request snapshot for this run.
5. Open the session from **Projects** or **Runs** to see messages, actions,
   changed files, and the run's permission snapshot. Edits apply immediately.

No separate request/planner/review step is required for local sessions. The main
navigation is Projects and Runs; older detailed review routes remain accessible
for historical runs. Project edits apply on the next launch. Suggestions replace
only the unsaved permission draft and never silently change a running session.

## Local setup and enforcement

With the app running and the folder saved as a Docker project:

```bash
cd /path/to/your/project
periscope codex
```

Codex opens in your existing terminal. Its `/workspace` is a live bind mount of
the saved project's folder. Permitted edits appear immediately in your editor.
The app observes file changes and proxy traffic, and shows a
session-relative diff when the session ends. The container enforces write mounts
and the proxy's network allowlist regardless of the instructions given to Codex.

## First-time setup

From this Periscope repository:

```bash
npm ci
npm run docker:build
npm link --ignore-scripts
```

`npm link` installs the `periscope` command in your npm global bin directory.
Without installing, run `node /absolute/path/to/airlock/scripts/periscope.mjs codex`.

Use the backend/frontend startup instructions in [permissions-demo.md](permissions-demo.md).
On Colima the backend needs `DOCKER_HOST` pointing at that Docker context and
`AGENTGUARD_DOCKER_PROXY_HOST=host.docker.internal`. Docker must share the selected
local project path. Allow `auth.openai.com` and `chatgpt.com` in the project's
Internet hosts for **ChatGPT account login**. No API key is needed. The launcher
prints a browser link and device code; open the link and sign in with your account.
If required, enable device-code login in your ChatGPT security settings first.
See [OpenAI's authentication instructions](https://learn.chatgpt.com/docs/auth).

Codex and login both attach directly to the terminal. New sessions stream selected
Codex messages and tool requests into Periscope; login output, private reasoning,
and full tool results are excluded. Codex account login is retained in
`~/.periscope/codex-auth/auth.json` (directory mode 700, file mode 600), separate
from your normal Codex installation. Only that file is restored into new
containers; configuration and conversations are not copied. No `OPENAI_API_KEY`
is injected in account-login mode.

API-key authentication remains an explicit opt-in with
`PERISCOPE_CODEX_AUTH=api-key periscope codex`. Only that mode requires the key on
the backend, the corresponding project secret grant, and `api.openai.com` access.

Save the folder and its permissions under **Projects** in the app. Local mode
currently requires an explicit read-only root and existing writable directories:

```text
/workspace        read
/workspace/src    read_write
/workspace/tests  read_write
```

Empty permissions, a writable project root, wildcard grants, file grants,
missing writable directories, escaping symlinks, and read-only children inside
writable directories are rejected before launch. Git metadata stays read-only.
This first version intentionally supports directory-scoped edits; root files
such as package.json remain read-only.

The launcher selects the most specific saved project containing your current
directory. If there are duplicate project configurations, select one explicitly:

```bash
periscope codex proj_example
```

The session starts at that project's root and uses the currently checked-out
branch. It never changes branches, initializes Git, or modifies the host index
to gather its diff. Existing dirty/staged files are included in the baseline,
so the final diff describes changes made during the session.

For an authenticated backend, set `PERISCOPE_COOKIE_FILE` to a private file
containing the raw `periscope_session=...` cookie header from your signed-in
session. A curl Netscape cookie jar is not that format. The helper never prints
the cookie. `PERISCOPE_API` selects another localhost backend port; remote
backends are rejected. Alternatively, `periscope login --api http://127.0.0.1:3000` saves a Periscope session for that backend. This is separate from ChatGPT login.

## Try it on the bundled fixture

The existing permission demo seed saves the fixture as a project:

```bash
npm run demo:permissions -- --seed
cd fixtures/permissions-demo-repo
periscope shell
```

In the supervised shell:

```bash
echo hello > src/hello.txt       # Appears on your actual disk immediately
echo nope >> infra/prod.tf      # Read-only filesystem error
curl http://example.com         # Blocked by the policy proxy
exit
```

Then run `periscope codex` from the same folder. It uses the same saved grants.
Ask Codex to create a file under src and try an infrastructure edit. The launcher
prints the run URL; open **Timeline** to see recorded activity, or the workbench
to inspect events and the resulting changes.

## Session lifecycle and limits

- Exiting normally finalizes the session, collects its diff, and removes only
  the container, relay, network, and private audit snapshot. Your folder and
  edits remain. **Stop** in the app also stops the agent without undoing edits.
- A heartbeat stops the container after roughly 30 seconds without the CLI.
  Sessions also have a 30-minute limit. Restarting the backend ends active
  sessions; in development, editing backend source triggers this restart.
- Permission changes saved in Projects apply to the next session. Stopping and
  relaunching is required to change filesystem grants.
- Codex uses Docker's terminal directly, including terminal sizing and resize.
  A separate observer reads selected public records from its session log and
  emits messages, tool requests, and result acknowledgments as agent-reported
  evidence. Granted secret values and common credential patterns are redacted;
  this is not a guarantee that all sensitive prose can be detected. File changes,
  network-proxy events, and the final diff remain independently observed. `periscope shell` additionally records raw shell output; its simple
  recorder does not support resize forwarding or reconnect.
- The whole project is readable. Tools/MCP declarations aren't executable
  allowlists. Granted secrets can be read by the agent. See the full enforcement
  limitations in [permissions-demo.md](permissions-demo.md).
- Concurrent edits from your editor or another process are also observed; this
  system cannot reliably attribute every host-side change to Codex. Avoid
  concurrent editing during a controlled demonstration. Audit snapshots omit
  `.git`, `node_modules`, and `.next`; those are not covered by the final diff.
- This is direct editing, so review is retrospective. The app labels local
  sessions accordingly and refuses to reapply their diff through Create PR.
- Live-local runs are blocked through the public gateway. Never expose an
  unauthenticated local backend publicly.

`periscope codex` runs the installed Codex CLI inside Docker with its inner
sandbox disabled so that Periscope's outer environment owns enforcement. Plain
`codex` run directly on the host is not supervised by Periscope.

## Follow your terminal session in the web app

Open **Projects → your project**. The Terminal sessions section lists active and
previous runs and refreshes every four seconds. Its command launches this exact
project. The terminal also prints a direct **Watch** link to the workbench and a
**Project & permissions** link.

The workbench Activity tab streams observed file and proxy events; changed files
appear during the run, with a final patch after it ends. Use **Stop** to end the
session. Project permission edits affect the next launch, so stop, save, and
relaunch to enforce new filesystem grants. The amendment panel can decide
requests that arrive through Periscope's control channel; native agent approval
prompts must be answered in the terminal.

The canonical CLI is `bin/periscope.mjs`. Codex, Claude Code, and shell use immediate local
edits; OpenCode, Cursor and `run --` commands still use
workspace copies. `--repo`, `--project`, `--api`, `--ui`, and `--timeout` select
the local session settings. Agent passthrough arguments are not supported yet.

## Simplified session view

The workbench now has a lazy-loading project file explorer. Each file or folder
shows its inherited access from the run's permission snapshot; this is the
agent's access, not the human operator's. Green dots mark observed file activity.
Select a file to inspect its final diff after the session ends. Deleted files
remain available in the Changed during session list. The explorer lists current
host files for local sessions, not a historical snapshot.

Conversation & actions shows user prompts, visible Codex replies, tool requests
(including search requests when recorded by this Codex version), and observed
file changes. Tool results are acknowledged without retaining arbitrary output.
Routine proxy and process events are hidden under Show connection details.
The session log is agent-reported and can be incomplete or altered by the agent;
file events are separate evidence, not proof that a particular tool caused them.
Existing sessions require a fresh `periscope codex` launch to enable the observer.
There is no retrospective import or web approval of native terminal prompts.

## Attempts and attribution

Local workspaces are shared with your editor. Filesystem and final Git changes
therefore carry `attribution: unattributed`; they no longer trigger policy
findings that claim the agent modified those files. The default workbench hides
these records and marks files only from successful agent-reported patch/file-change
results. It does not infer an edit merely from a requested command or matching
filename. Arbitrary shell-script edits without a usable edit report may be
missing; this is not kernel-level per-process attribution.

Command cards show the shell command, working directory, and escalation request.
Recognized literal file operations show read/write/delete/access attempts and
the relevant configured permission. Dynamic paths and arbitrary programs are
shown as commands without guessed targets. Read-only allows reading; an outside
project path is not automatically proof of an escape (the container has its own
system files). Result summaries retain exit codes and permission-error categories,
not full output. An attempt without a result remains unknown, not blocked or
successful. Exec results can describe several operations; their outcome applies
to the command, not necessarily every listed target.

Whole-workspace diffs may mix editor and agent edits, even in the same file.
They are available under raw evidence and are explicitly not agent-only diffs.
Existing sessions need a fresh launch for the new result summaries.

## Claude Code

Select **Claude Code** in the project form, review permissions, and save. From
that folder, use the exact project command shown in the app:

```bash
periscope claude --project proj_example
```

The launcher runs `claude auth login --claudeai` in your terminal. Follow its
browser sign-in flow; no API key is required. Account mode removes inherited
Anthropic keys/tokens. Credentials remain in the disposable container, so a new
session requires signing in again. Optional API mode is
`PERISCOPE_CLAUDE_AUTH=api-key periscope claude --project proj_example`, with a
backend `ANTHROPIC_API_KEY` and matching project secret grant.

Account mode requires the saved allowlist to cover `api.anthropic.com`,
`claude.ai`, `claude.com`, and `platform.claude.com`. Suggestions include these
hosts for Claude projects; launch validates them without widening permissions.
Optional telemetry, automatic updates, and Claude.ai MCP connectors are disabled.
See Claude's [network documentation](https://code.claude.com/docs/en/network-config).

Claude keeps its normal terminal permission prompts. Periscope does not pass a
permission-bypass flag. The outer Docker mounts and network proxy still enforce
the saved project scope even if you approve a tool in Claude's terminal.
Plain `claude` on the host is not supervised.

[Claude hooks](https://code.claude.com/docs/en/hooks) report user prompts, final
assistant replies, tool attempts, approval requests, and success/failure summaries
to the same workbench. Successful Write/Edit/MultiEdit/NotebookEdit reports mark
changed files. Bash commands are expandable, but arbitrary shell edits are not
automatically attributed. Full tool outputs, reasoning, and login output are
excluded. Hooks are agent-reported evidence and can be incomplete or altered;
the independent filesystem and proxy records remain available as raw evidence.

## Prepare Codex login before a demo

Run `periscope codex --project proj_example` once, sign in, then exit Codex
normally. Later launches reuse the Periscope login cache and skip device login
when `codex login status` succeeds. This uses Codex's documented
[file credential cache](https://learn.chatgpt.com/docs/auth). Revoked or expired
credentials can still require signing in again; login status is not an online
account health check.

Tokens are saved after login, every ten seconds during the session, and before
normal exit. A forced stop can lose the most recent refresh. Only one persistent
Codex session runs at a time to avoid conflicting token refreshes. After a CLI
crash, remove the `~/.periscope/codex-auth/session.lock` directory once you have
confirmed no persistent session is running.

For disposable login, set `PERISCOPE_CODEX_PERSIST_LOGIN=0`. To forget the cached
login, close active sessions and delete `~/.periscope/codex-auth/auth.json`.
The file contains account tokens; keep it private. Persistence does not change
project filesystem or network grants. Claude login remains disposable.
