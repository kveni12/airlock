import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import type { EventCollector } from "../events/eventCollector.js";
import { hostAllowed } from "../policy/policyEngine.js";
import type { RunRecord } from "../types.js";

/** Virtual hostnames the sandboxed agent can call (via the proxy) to talk to Periscope itself. */
export const CONTROL_HOSTS = new Set(["periscope.internal", "agentguard.internal"]);

export interface ControlRequest {
  method: string;
  path: string;
  body: unknown;
}

export type ControlHandler = (request: ControlRequest) => Promise<{ status: number; body: unknown }>;

export class NetworkProxy {
  private server?: http.Server;
  private port?: number;
  private readonly allowedHosts: string[];

  constructor(
    private readonly run: RunRecord,
    allowedHosts: string[],
    private readonly events: EventCollector,
    private readonly control?: ControlHandler
  ) {
    this.allowedHosts = [...allowedHosts];
  }

  /** Widens the live allowlist (approved mid-run amendments). Returns the hosts that were new. */
  allow(hosts: string[]): string[] {
    const added = hosts.filter((host) => !this.allowedHosts.includes(host));
    this.allowedHosts.push(...added);
    return added;
  }

  async start(): Promise<number> {
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });

    this.server.on("connect", (request, clientSocket, head) => {
      void this.handleConnect(request, clientSocket as net.Socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("Proxy server was not created"));
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "0.0.0.0", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not bind to a TCP port");
    this.port = address.port;
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  getProxyUrl(hostname = "host.docker.internal"): string | undefined {
    return this.port ? `http://${hostname}:${this.port}` : undefined;
  }

  private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const destination = parseHttpDestination(request);
    if (!destination) {
      response.writeHead(400);
      response.end("Invalid proxy request");
      return;
    }

    if (CONTROL_HOSTS.has(destination.hostname)) {
      await this.handleControl(request, response, destination.path);
      return;
    }

    const allowed = this.isAllowed(destination.hostname);
    await this.emitNetworkEvent(destination.hostname, allowed, destination.port);
    if (!allowed) {
      response.writeHead(403);
      response.end("Blocked by Periscope network policy");
      return;
    }

    const upstream = http.request(
      {
        hostname: destination.hostname,
        port: destination.port,
        method: request.method,
        path: destination.path,
        headers: request.headers
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );

    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Periscope proxy upstream error");
    });
    request.on("error", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  private async handleConnect(request: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    clientSocket.on("error", () => clientSocket.destroy());
    const [hostname, portText] = (request.url ?? "").split(":");
    const port = Number(portText) || 443;
    const allowed = this.isAllowed(hostname);
    await this.emitNetworkEvent(hostname, allowed, port);

    if (!allowed) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => upstreamSocket.destroy());
  }

  private async handleControl(request: http.IncomingMessage, response: http.ServerResponse, path: string): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!this.control) return send(404, { error: "Periscope control channel is not enabled for this run" });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let body: unknown = undefined;
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "Control channel body must be JSON" });
      }
    }
    try {
      const result = await this.control({ method: request.method ?? "GET", path, body });
      send(result.status, result.body);
    } catch (error: unknown) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Deny by default: an empty allowlist means the agent has no network access. */
  private isAllowed(hostname: string): boolean {
    return hostAllowed(hostname, this.allowedHosts);
  }

  private async emitNetworkEvent(hostname: string, allowed: boolean, port: number): Promise<void> {
    await this.events.emitEvent({
      runId: this.run.id,
      taskId: this.run.taskId,
      agentId: this.run.agentId,
      category: "network",
      action: allowed ? "request" : "blocked",
      resource: hostname,
      allowed,
      metadata: { port }
    });
  }
}

function parseHttpDestination(request: http.IncomingMessage): { hostname: string; port: number; path: string } | undefined {
  try {
    const parsed = new URL(request.url ?? "");
    return {
      hostname: parsed.hostname,
      port: Number(parsed.port) || 80,
      path: `${parsed.pathname}${parsed.search}`
    };
  } catch {
    const host = request.headers.host;
    if (!host) return undefined;
    const [hostname, portText] = host.split(":");
    return {
      hostname,
      port: Number(portText) || 80,
      path: request.url ?? "/"
    };
  }
}
