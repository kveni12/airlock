// Single-origin reverse proxy for sharing a Periscope instance publicly (e.g. through a Cloudflare quick tunnel).
//
//   UI       →  frontend (FRONTEND_PORT, default 3001)
//   /api/*   →  backend  (BACKEND_PORT,  default 3000)
//
// Without GATEWAY_PASS the site is browse-anywhere but write access is restricted to a safe subset:
// no runtime setup, no host repo browsing, no shared rule edits, and runs may only start in the Docker
// sandbox against the bundled fixtures/* repos. With GATEWAY_USER/GATEWAY_PASS set, everything is behind
// HTTP basic auth and the only blocks left are the host-touching routes.
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const FRONTEND = { host: "127.0.0.1", port: Number(process.env.FRONTEND_PORT ?? 3001) };
const BACKEND = { host: "127.0.0.1", port: Number(process.env.BACKEND_PORT ?? 3000) };
const USER = process.env.GATEWAY_USER ?? "periscope";
const PASS = process.env.GATEWAY_PASS;
const EXPECTED = PASS ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") : null;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Always blocked: these touch the host machine or shared configuration.
const BLOCKED = [
  /^\/api\/runtime\//,
  /^\/api\/repos?(\/|$)/,
  /^\/api\/request-rules(\/|$)/,
  /^\/api\/findings\/[^/]+\/resolve$/
];

// Writes allowed without a password: they only edit the JSON store or start sandboxed fixture runs.
const PUBLIC_WRITES = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/requests(\/|$)/,
  /^\/api\/intents(\/|$)/,
  /^\/api\/reviews(\/|$)/,
  /^\/api\/findings(\/|$)/,
  /^\/api\/runs(\/|$)/,
  /^\/api\/projects(\/|$)/
];

// Anything that launches an agent must use the disposable Docker sandbox on a bundled fixture repo.
const LAUNCHES_AGENT = [/^\/api\/runs\/?$/, /^\/api\/intents\/generate\/?$/];
const FIXTURE_REPO = /^fixtures\/[A-Za-z0-9_-]+\/?$/;

function launchDenied(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch { return "invalid JSON"; }
  if (parsed?.structuredOutput !== undefined && parsed?.repo === undefined) return null; // intent from pasted JSON, no run
  if (parsed?.runtime?.provider !== "docker") return "Public demo: only the Docker runtime is allowed (pick runtime \"docker\").";
  if (!FIXTURE_REPO.test(String(parsed?.repo?.path ?? ""))) return "Public demo: repo path must be one of the bundled fixtures/* repos.";
  return null;
}

function denied(req, path) {
  if (BLOCKED.some((re) => re.test(path))) return true;
  return !EXPECTED && path.startsWith("/api/") && !READ_METHODS.has(req.method) && !PUBLIC_WRITES.some((re) => re.test(path));
}

function forbid(res, message) {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function proxy(req, res, path, body) {
  const target = path.startsWith("/api/") ? BACKEND : FRONTEND;
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };
  delete headers.authorization;
  if (body) headers["content-length"] = String(body.length);
  const up = http.request({ ...target, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end("upstream unavailable"); });
  if (body) up.end(body); else req.pipe(up);
}

function unauthorized(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Periscope"', "Content-Type": "text/plain" });
  res.end("Authentication required");
}

const server = http.createServer((req, res) => {
  if (EXPECTED && req.headers.authorization !== EXPECTED) return unauthorized(res);
  const path = req.url.split("?")[0];
  if (denied(req, path)) return forbid(res, "Disabled on the public demo: this action would run code on the host.");
  if (!EXPECTED && req.method === "POST" && LAUNCHES_AGENT.some((re) => re.test(path))) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const reason = launchDenied(body);
      if (reason) return forbid(res, reason);
      proxy(req, res, path, body);
    });
    return;
  }
  proxy(req, res, path);
});

// Next.js HMR websocket (frontend only)
server.on("upgrade", (req, socket, head) => {
  if (EXPECTED && req.headers.authorization !== EXPECTED && !req.headers.cookie) { socket.destroy(); return; }
  const up = net.connect(FRONTEND.port, FRONTEND.host, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`gateway on http://127.0.0.1:${PORT} (${EXPECTED ? "basic auth" : "browse-anywhere, restricted writes"})`));
