import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import type { EventCollector } from "../events/eventCollector.js";
import { hostAllowed } from "../policy/policyEngine.js";
import type { RunRecord } from "../types.js";

export class NetworkProxy {
  private server?: http.Server;
  private port?: number;

  constructor(
    private readonly run: RunRecord,
    private readonly allowedHosts: string[],
    private readonly events: EventCollector
  ) {}

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
