# Local project → permissions → interactive Codex demo

For **immediate edits to the real folder**, use the new
[`periscope codex` launcher](local-cli.md). The `demo:permissions` commands below
continue to use separate copies unless invoked through that launcher.

This demo uses a real Docker sandbox with the existing runtime, filesystem
monitor, policy proxy, event store, and final Git diff. The native-terminal
attachment is a prototype: there is no browser terminal or full interactive
Codex event recording yet. It demonstrates permissions, not the planner/review
approval workflow. It does not attach a declared intent or auto-approve a review.

## Start on macOS with Colima

From the Periscope repository root, with Colima/Docker already running:

```bash
npm ci
npm --prefix frontend ci
npm run docker:build
```

The image contains Codex. In the terminal that will run the backend:

```bash
export DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
export AGENTGUARD_WORKSPACE_ROOT="$PWD/data/workspaces"
export AGENTGUARD_DOCKER_PROXY_HOST=host.docker.internal
export PERISCOPE_DEMO_GRANTED=demo-only-granted
export PERISCOPE_DEMO_DENIED=demo-only-denied
# Codex uses ChatGPT account login; no API key is required.
HOST=127.0.0.1 PERISCOPE_AUTH_DISABLED=1 npm run dev
```

This is an explicitly local, unauthenticated demo backend. Do not tunnel it.
For an authenticated instance, leave auth enabled and set
`PERISCOPE_DEMO_COOKIE_FILE` to a local file containing the raw
`periscope_session=...` cookie header obtained from your signed-in session. The
helper reads the file without printing it; a Netscape-format curl cookie jar is
not the expected format.

`DOCKER_HOST` makes dockerode use the same daemon as the Docker CLI. The shared
workspace location avoids Colima's unshared macOS `/var/folders` temporary
directory. Keep it **outside the project you intend to copy**; the example is
outside the bundled fixture, but choose another shared location for a run on
the Periscope repository itself.

The opt-in proxy relay uses Node from the runtime image. It has no credentials
or workspace mounts and joins both the run's internal network and Docker's
ordinary bridge. The agent joins only the internal network. The relay forwards
one port to this run's existing policy proxy on the macOS host. On Linux with
the backend directly on the Docker host, this relay generally isn't needed.

In another terminal:

```bash
npm --prefix frontend run dev
```

In a third terminal:

```bash
npm run demo:permissions -- --seed
```

Open the printed `http://localhost:3001/projects/...` URL. The project points to
`fixtures/permissions-demo-repo`. Seeding again preserves your saved settings.

## Configure the permissions in the UI

Use Docker and this starting scope:

| Setting | Grant |
| --- | --- |
| `/workspace` | Read |
| `/workspace/src` | Read/write |
| `/workspace/tests` | Read/write |
| Internet hosts | `api.openai.com`, `auth.openai.com`, `chatgpt.com` |
| Secrets | `PERISCOPE_DEMO_GRANTED` |
| MCP servers | None |
| Tools | `shell`, `filesystem` (declarations, not enforced executable allowlists) |

Save the project. The helper reads its current saved settings on every launch.
Do not grant the workspace root write access and expect a child read-only
exception to work: the local-session validator deliberately rejects those
nested exceptions. Use a read-only root and explicit writable subdirectories.

## First prove the permissions without an AI model

```bash
npm run demo:permissions -- --probe
```

This starts a new sandbox, executes deterministic probes, prints PASS/FAIL
results, collects the diff, and removes its container, relay, network, and copied
workspace. It only permits the bundled fixture as the probe target.

Expected: 13 checks pass, exit code 0, and the final changed-file list contains
only `src/permission-probe.txt` and `tests/permission-probe.txt`.

The probes check allowed writes; protected writes, creation, and deletion;
read-only reads; granted and ungranted dummy environment variables; the fixture's
test; an explicit 403 from the policy proxy; an unauthenticated 401 from the
allowed OpenAI API; and a failed direct external TCP connection. They require
the fixture files to be present first. A missing mount or unreachable proxy is
a failure, not evidence that permissions worked. A single direct-TCP probe is
not an exhaustive network-security assessment.

## Open a native shell or Codex window

Run these from your own terminal, rather than a noninteractive command runner:

```bash
npm run demo:permissions -- --shell
# Or, sign in with your ChatGPT account:
npm run demo:permissions -- --codex
```

The helper creates a fresh run from the saved project, waits for its container,
and uses `docker exec -it` to attach your terminal. It prints a URL where you can
watch that run in Periscope. The host's Codex configuration and login files are
not mounted. Codex prints a device-login link and code so you can sign in with
your ChatGPT account. Login output is not included in the terminal transcript.
Codex login is retained in a private Periscope cache for later launches. See
[login persistence](local-cli.md#prepare-codex-login-before-a-demo). Enable
device-code login in ChatGPT security settings if needed.

The Codex launch disables Codex's inner approvals/sandbox so this demo tests
**Periscope's outer Docker restrictions**. The helper refuses non-Docker
projects. This launch mode should not be copied into a host terminal outside
the container. See the [official CLI reference](https://developers.openai.com/codex/cli/reference/).

Suggested prompt:

> This is a disposable permission test. Try each operation and report the actual
> result, without modifying permissions or requesting wider grants: create
> src/allowed.txt; append a comment to infra/prod.tf; append a newline to
> package.json; fetch https://api.openai.com/v1/models without credentials; fetch
> http://example.com through the configured proxy; check whether
> PERISCOPE_DEMO_GRANTED and PERISCOPE_DEMO_DENIED are set without printing their
> values. Do not expose credentials. Run npm test. Summarize which actions the
> environment allowed and denied.

For a shell demo, directly run:

```bash
echo allowed > src/allowed.txt
echo blocked >> infra/prod.tf
curl -i --max-time 8 http://example.com
npm test
exit
```

Exit normally (`exit` in Bash, `/quit` or Ctrl-D in Codex) to finalize the run.
Closing/killing the helper abruptly can leave the sandbox alive until its
30-minute timeout; use **Stop** on the run page. Editing project permissions
affects the **next** sandbox; it does not change mounts in an existing session.

To use another saved project with shell/Codex, append its project ID. The helper
copies that project's path and uses its settings. `PERISCOPE_DEMO_IMAGE` selects
an alternative locally built image; it must contain Bash, Node, and (for Codex)
Codex. No image is silently substituted.

## What remains missing or limited

- **Native terminal integration:** no Open terminal button, browser PTY, resize,
  reconnect, or robust helper-disconnect lifecycle. This is a local CLI bridge.
- **Interactive evidence:** file writes, proxy events, and the final diff are
  observed. Docker-exec stdout/stderr, denied-write messages, individual tool
  calls, and your interactive prompts do not enter the existing output monitor.
  The deterministic probe does enter that monitor because it is the primary
  process. Do not present the interactive session as a complete audit trail.
- **Read access:** the whole copied repository is readable. A read-only mount
  prevents writes; it does not hide `.env` files or unlisted directories. Secret
  environment injection does not protect secrets already present in project files.
- **Tools/MCP:** the configured lists do not prohibit binaries or mediate every
  tool/MCP call. Kernel-level subprocess/read tracing is absent.
- **Mount semantics:** empty filesystem grants mean a writable workspace. A
  writable parent overrides nested read-only paths at the mount layer. Glob
  grants widen to directories. These scopes need stronger validation/enforcement
  before the UI can promise arbitrary permission combinations.
- **Network scope:** hostnames (including their subdomains), not HTTP paths or
  request contents, are controlled. HTTPS isn't decrypted. The Docker bridge
  gateway and other host services, DNS, IPv6, and malicious bypass attempts need
  a broader audit. Allowing an API host does not prevent uploading readable data
  to that allowed host.
- **Runtime parity:** Lima/process do not enforce the same granular writes as
  Docker. Use Docker for this demonstration.
- **Secrets and live grants:** only granted environment names are injected, but
  once injected an agent can read them. Filesystem/secret changes require a new
  container. Native interactive approval/amendment UX is not implemented here.

The demo is ready for shell and permission probes without credentials. An actual
Codex conversation requires completing account login in your terminal/browser.
Passing probes does not establish that every possible policy is enforced.
