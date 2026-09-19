# Plan: user login + VS Code-style workspace folder picker

## Why these two are one feature

Today the workspace is a free-text field — `repoPath` in `new-request-flow.tsx` line 185, sent as `repo.path` to `POST /api/runs`, validated only by `assertReadableDirectory` in `runtimeManager.ts`. The backend has **no authentication at all**: every route in `app.ts` is open, and CORS is `origin: true`.

A folder-browsing API is a filesystem disclosure primitive. Adding it to an unauthenticated backend would let anyone who can reach port 3000 enumerate the operator's home directory and then start a `process`-runtime agent against any of it. So login lands first, and the browse API is only ever reachable behind it.

Login also fixes an existing governance gap: approvals (`IntentApproval.decidedBy`, `Review` approval, `HumanRequest.createdBy`) are currently self-declared strings. "Recorded human approval" is the product's core claim and it should be bound to an authenticated identity.

## Open question that changes the design

**Is Periscope meant to run locally on the operator's own machine, or hosted for a team?**

- **Local-first** (what the README implies: "Repo path on the machine running the backend"): browsing the backend's filesystem *is* browsing your own filesystem. Single operator account, session cookie, roots default to `$HOME`. This is what the plan below assumes.
- **Hosted / multi-user**: browsing the server's filesystem is meaningless (the user's code isn't there) and hostile (one tenant sees another's checkouts). The right shape there is per-user accounts + workspaces sourced from a git clone URL or from a paired local agent daemon. The auth phase below is identical; the picker phase would be replaced by a repo-URL flow.

Everything in Phase 1 is shared between both, so it can start before this is decided.

---

## Phase 1 — Authentication

### Storage
Extend `StoredData` with a `users` collection and add `JsonStore` methods (`createUser`, `getUserByEmail`, `listUsers`, `updateUser`). Sessions live in a separate short-lived store (in-memory `Map` is fine for MVP; a `sessions` collection in the JSON store if survival across restarts matters).

```ts
interface User { id: string; email: string; displayName: string; passwordHash: string; salt: string; role: "admin" | "operator"; createdAt: string; lastLoginAt?: string; }
interface Session { token: string; userId: string; createdAt: string; expiresAt: string; }
```

### Hashing
`node:crypto` `scrypt` with a per-user random salt and `timingSafeEqual` comparison — no new native dependency, no bcrypt build step. Wrapped in `src/auth/password.ts` so it can be swapped later.

### First-run bootstrap
On startup, if `users` is empty, the server generates a one-time setup token and prints it to the log. `POST /api/auth/bootstrap` accepts `{ setupToken, email, password, displayName }` and creates the first admin. This avoids the race where whoever hits the box first claims the instance.

### Routes (`src/auth/authRoutes.ts`)
```
POST /api/auth/bootstrap   -> first admin, one-time
POST /api/auth/login       -> sets httpOnly session cookie
POST /api/auth/logout
GET  /api/auth/me          -> { user } or 401
POST /api/auth/users       -> admin only, invite/create additional operators
```

### Guarding everything else
A Fastify `onRequest` hook in `app.ts` that rejects with 401 unless the path is `/health` or `/api/auth/*`. Decorate `request.user` so downstream handlers can attribute actions.

Two details that will bite otherwise:
- **CORS**: `origin: true` plus `credentials: true` reflects any origin — that must become an explicit allowlist (`PERISCOPE_ALLOWED_ORIGINS`, default `http://localhost:3001`).
- **SSE**: `GET /api/runs/:id/stream` is consumed by `EventSource`, which cannot set headers. Cookie auth works, but the frontend must construct it with `{ withCredentials: true }` and the CORS config above must be exact-origin. Check `lib/event-stream.ts` when wiring this.
- **CSRF**: `SameSite=Lax` cookie + an `Origin` header check on all non-GET requests. No token machinery needed for a localhost tool.

### Frontend
- `app/login/page.tsx` and `app/setup/page.tsx` (bootstrap), styled with the existing `components/ui.tsx` primitives.
- `middleware.ts` redirecting unauthenticated navigation to `/login`.
- `lib/api.ts`: add `credentials: "include"` to every fetch, and make `AgentGuardApiError` with status 401 trigger a redirect to `/login`.
- `components/app-shell.tsx`: current user + sign-out in the sidebar footer.

### Attribution (small but the reason to bother)
Wire `request.user` into `RequestService.create` (`createdBy`), `IntentService` approve/reject (`decidedBy`), and review approve/reject, replacing client-supplied strings. Server-side identity, not a text field the caller chooses.

---

## Phase 2 — Workspace browse API

New module `src/workspace/workspaceBrowser.ts`, routes in `src/workspace/workspaceRoutes.ts`.

```
GET  /api/workspace/roots                  -> [{ label: "Home", path }, { label: "Periscope", path: cwd }, ...configured]
GET  /api/workspace/list?path=/Users/x/code -> { path, parent, entries[] }
GET  /api/workspace/search?q=api&root=      -> { matches[], truncated, tookMs }
POST /api/workspace/validate                -> { path, exists, isDirectory, readable, isGitRepo, branch, fileCount, warnings[] }
GET  /api/workspace/recents                 -> per-user recent selections
```

`entry = { name, path, isDirectory, isGitRepo, isSymlink, hidden }`. Directories only by default, with a flag to include files for display context. **Never returns file contents** — metadata only.

### Containment (the part to get right)
`src/workspace/pathGuard.ts`:
1. `path.resolve` the input.
2. `fs.realpath` it — resolves symlinks *before* the containment check, so a symlink inside an allowed root pointing at `/etc` is rejected.
3. Assert the realpath equals or is a child of one of the allowed roots (reuse the containment idea from `pathWithinPermission` in `policyEngine.ts`, but with a `path.relative`-based check rather than string prefixing, so `/home/user-evil` doesn't match root `/home/user`).
4. Deny-list regardless of root: `.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.docker`, keychains, and anything matching the existing `DEFAULT_SENSITIVE_PATTERNS`.
5. Roots come from `PERISCOPE_BROWSE_ROOTS` (colon-separated), defaulting to `$HOME` plus the Periscope checkout.

Reject with 403 and a generic message; do not leak whether a path outside the root exists.

### Bounds
- `opendir` with `withFileTypes`, cap at ~1000 entries per listing with a `truncated` flag.
- Search: breadth-first, max depth 6, hard 2-second deadline, max 200 matches, skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `venv`, `target`. Abort on client disconnect.
- Rate-limit the search route.

### Tests
`tests/pathGuard.test.ts` is the important one: `..` traversal, absolute escape, symlink escape, sibling-prefix (`/home/userx` vs root `/home/user`), deny-listed dirs, non-existent paths. Plus `tests/workspaceBrowser.test.ts` against a temp fixture tree for listing/search/validate behavior.

---

## Phase 3 — Picker UI

`frontend/components/workspace-picker.tsx`, a modal opened from the "Repo path" field in `new-request-flow.tsx`.

Behavior modeled on VS Code's *Open Folder* + quick-open:
- **Breadcrumb path bar** at the top, each segment clickable; also editable as raw text for pasting a path (keeps today's escape hatch).
- **Left rail of roots/recents** — Home, the Periscope checkout, configured roots, and the user's recent workspaces.
- **Main list** of subdirectories, with a git-branch badge on anything that is a git repo, and `.`-prefixed folders hidden behind a toggle.
- **Type-to-filter**: typing filters the current directory instantly; if the query has no local match (or the user hits a "search everywhere" affordance), fall back to the `/search` endpoint with a debounce and a spinner.
- **Keyboard**: ↑/↓ to move, Enter to descend, Backspace/← to go up, Cmd/Ctrl+Enter to select the highlighted folder, Esc to cancel.
- **Footer** shows the `validate` result for the highlighted folder — git repo / branch / not a git repo warning (Periscope will `git init` a baseline, worth saying so) / unreadable / very large. Confirm button disabled when invalid.

On confirm: set `repoPath`, record it in per-user recents, close. The existing text input stays as the field's display, so nothing breaks if the API is unavailable.

Reuse: the same picker is the natural control anywhere else a host path is needed later.

---

## Phase 4 — Polish

- Per-user recents and a default workspace root in the store.
- Runs list / run detail show which authenticated user started each run.
- `README.md`: new auth setup section, `PERISCOPE_BROWSE_ROOTS`, and an honest entry in *Security Limitations* — browse is root-constrained metadata-only, but an authenticated operator can still point a `process`-runtime agent at anything inside those roots.

---

## Dependencies

`@fastify/cookie` (session cookie), optionally `@fastify/rate-limit`. Password hashing and path handling use the Node standard library. Nothing new on the frontend — `lucide-react` already has the folder/search icons.

## Suggested PR sequence and effort

| PR | Contents | Effort |
| --- | --- | --- |
| 1 | Users + sessions + auth routes + guard hook + CORS/SSE fix + login/setup pages | ~1 session |
| 2 | `pathGuard` + browse/search/validate API + tests | same session as 1, or a short second |
| 3 | Picker modal wired into the new-request flow | ~1 session |
| 4 | Attribution, recents, README | short follow-up |

Phases 1 and 2 are backend-only and independently testable with curl; phase 3 is where UI verification is worth doing.
