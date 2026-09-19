# AgentGuard frontend

This Next.js app is the review and runtime-observability interface for the AgentGuard backend in the parent directory.

## Run locally

Start the backend from `agent-guard`:

```powershell
npm install
npm run dev
```

Then start the frontend from `agent-guard/frontend`:

```powershell
npm install
npm run dev
```

Open `http://localhost:3001`. The frontend uses `http://localhost:3000` by default. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_AGENTGUARD_API_URL` when the API is hosted elsewhere.

## Data boundaries

Overview, Agents, agent details, and Activity use the current backend endpoints for runs, permissions, events, files, agent profiles, health, and run event streams. Empty and disconnected states remain usable with labeled sample content.

Reviews is a deliberate UI prototype. The backend does not yet expose review, finding, resolution, or approval endpoints, so review records and decisions are local demo data. Replace `lib/review-data.ts` and the local decision state after those API contracts are added.

## Checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

For a hosted deployment, point `NEXT_PUBLIC_AGENTGUARD_API_URL` at a browser-accessible HTTPS API and allow the frontend origin in the Fastify CORS configuration.
