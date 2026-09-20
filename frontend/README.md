# Periscope frontend

This Next.js app is the review and runtime-observability interface for the Periscope backend in the parent directory.

## Run locally

Start the backend from `periscope`:

```powershell
npm install
npm run dev
```

Then start the frontend from `periscope/frontend`:

```powershell
npm install
npm run dev
```

Open `http://localhost:3001`. The frontend uses `http://localhost:3000` by default. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_AGENTGUARD_API_URL` when the API is hosted elsewhere.

## Data boundaries

Overview, Agents, agent details, and Activity use the current backend endpoints for runs, permissions, events, files, agent profiles, health, and run event streams. Empty and disconnected states remain usable with labeled sample content.

Runs (`/runs`, `/runs/:id`) render the composed `GET /api/runs/:id/detail` and `/timeline` read models: human request → declared intent → permissions → observed behavior (with telemetry coverage) → result. Every action is a backend call: intent approve/reject, run stop, start review, finding dismiss/resolve (polls `/api/resolutions/:id`), and review approval.

Reviews (`/reviews`, `/reviews/:id`) list `GET /api/reviews` and act through `POST /api/findings/:id/{dismiss,resolve}` and `POST /api/reviews/:id/approve`. No review state lives in the browser.

New request (`/requests/new`) drives the pre-execution lifecycle: `POST /api/requests` → `POST /api/intents` or `POST /api/intents/generate` (read-only planner sandbox) → request↔intent alignment → approve/reject → `POST /api/runs` with `intentId`.

Provenance is preserved in the UI: badges distinguish `independent`, `agent_reported`, `inferred`, and `unavailable`; unavailable channels are never rendered as "nothing happened".

To seed data locally run `npm run demo:intent` in the parent repository with `AGENTGUARD_STORE_PATH` pointing at the backend's store, then start the backend.

## Checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

For a hosted deployment, point `NEXT_PUBLIC_AGENTGUARD_API_URL` at a browser-accessible HTTPS API and allow the frontend origin in the Fastify CORS configuration.
