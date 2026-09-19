import type { RunRecord } from "../types.js";

export interface SandboxCreateOptions {
  run: RunRecord;
  workspacePath: string;
  proxyUrl?: string;
  environment: Record<string, string>;
  onOutput?: (output: SandboxOutput) => void;
}

export interface SandboxOutput {
  stream: "stdout" | "stderr";
  line: string;
}

export interface SandboxHandle {
  id: string;
  name: string;
}

export interface SandboxProvider {
  readonly kind: "lima" | "docker";
  readonly proxyHostname: string;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  wait(handle: SandboxHandle): Promise<{ exitCode: number | null }>;
  stop(handle: SandboxHandle): Promise<void>;
  remove(handle: SandboxHandle): Promise<void>;
}

export function runtimeEnvironment(proxyUrl: string | undefined): Record<string, string> {
  return {
    ...(proxyUrl
      ? {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: "localhost,127.0.0.1",
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          no_proxy: "localhost,127.0.0.1"
        }
      : {}),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false"
  };
}
