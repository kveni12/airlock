import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PermissionSnapshot, RunRecord, RuntimeProviderKind } from "../types.js";

export interface SandboxCreateOptions {
  run: RunRecord;
  workspacePath: string;
  /** Which paths the sandbox may write; enforced by the provider's mounts where it can. */
  mounts: WorkspaceMounts;
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

export interface WorkspaceMounts {
  /** Whether the workspace root is mounted read-only or read-write. */
  root: "ro" | "rw";
  /** Relative paths (within the workspace) overlaid read-write when root is "ro". */
  writable: string[];
}

export interface SandboxProvider {
  readonly kind: RuntimeProviderKind;
  readonly proxyHostname: string;
  /**
   * "enforced" when the sandbox kernel refuses writes outside `mounts.writable` for this plan;
   * "observed" when out-of-scope writes can only be detected afterwards (process runtime, or a
   * provider that cannot express the requested overlay).
   */
  filesystemScope(mounts: WorkspaceMounts): "enforced" | "observed";
  /** Optional per-run network setup; returns the hostname the sandbox uses to reach the proxy. */
  prepareNetwork?(run: RunRecord): Promise<string>;
  /** Tear down what prepareNetwork created when the sandbox was never created. */
  releaseNetwork?(run: RunRecord): Promise<void>;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  wait(handle: SandboxHandle): Promise<{ exitCode: number | null }>;
  stop(handle: SandboxHandle): Promise<void>;
  remove(handle: SandboxHandle): Promise<void>;
}

/**
 * Turn the run's filesystem permissions into a mount plan. Planner runs are fully read-only.
 * A builder is read-write on the whole workspace only when the root itself is granted
 * read_write (or no filesystem scope was declared); otherwise the root is read-only and
 * each read_write grant becomes a writable overlay. Missing grant paths are created so the
 * agent can add files there.
 */
export async function planWorkspaceMounts(run: RunRecord, workspacePath: string, permissions: PermissionSnapshot): Promise<WorkspaceMounts> {
  if (run.workspaceAccess === "read_only") return { root: "ro", writable: [] };
  const grants = permissions.filesystem ?? [];
  if (!grants.length) return { root: "rw", writable: [] };
  const writable = grants.filter((grant) => grant.access === "read_write").map((grant) => relativeGrantPath(grant.path));
  if (writable.some((relative) => relative === "")) return { root: "rw", writable: [] };
  const unique = [...new Set(writable)].sort();
  // Drop grants nested inside another writable grant; the parent mount already covers them.
  const overlays = unique.filter((relative) => !unique.some((other) => other !== relative && relative.startsWith(`${other}/`)));
  for (const relative of overlays) {
    const absolute = path.join(workspacePath, relative);
    if (!absolute.startsWith(workspacePath + path.sep)) throw new Error(`Filesystem grant escapes the workspace: ${relative}`);
    const exists = await stat(absolute).then(() => true, () => false);
    if (!exists) await mkdir(absolute, { recursive: true });
  }
  return { root: "ro", writable: overlays };
}

/**
 * "/workspace/src/auth" | "src/auth/" | "./src" -> "src/auth"; workspace root -> "".
 * Glob grants ("src/**", "src/*.ts") widen to the directory before the first wildcard, since mounts are per path.
 */
export function relativeGrantPath(grantPath: string): string {
  let cleaned = grantPath.trim().replace(/\\/g, "/").replace(/^\/workspace(\/|$)/, "").replace(/^\.?\//, "");
  const wildcard = cleaned.indexOf("*");
  if (wildcard >= 0) cleaned = cleaned.slice(0, wildcard).replace(/[^/]*$/, "");
  cleaned = cleaned.replace(/\/+$/, "");
  if (!cleaned || cleaned === ".") return "";
  const normalized = path.posix.normalize(cleaned);
  return normalized === "." ? "" : normalized;
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
