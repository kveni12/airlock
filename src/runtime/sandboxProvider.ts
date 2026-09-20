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
  /** Human-readable progress while the sandbox is being prepared (image build, VM clone). */
  onStatus?: (message: string) => void;
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
  /** The access applied to the workspace root. "none" leaves the image's empty /workspace in place. */
  root: "none" | "ro" | "rw";
  /** Relative host paths mounted read-only as visible exceptions or overrides. */
  readonly: string[];
  /** Relative host paths mounted read-write as visible exceptions or overrides. */
  writable: string[];
  /** Existing file paths hidden from the container. */
  maskedFiles: string[];
  /** Existing directory paths hidden from the container. */
  maskedDirectories: string[];
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
  /** Remove sandboxes/networks/VMs left behind by runs that are no longer active; returns their run ids. */
  reapOrphans?(activeRunIds: Set<string>): Promise<string[]>;
  /** Optional per-run network setup; returns the hostname the sandbox uses to reach the proxy. */
  prepareNetwork?(run: RunRecord, proxyPort: number): Promise<string>;
  /** Tear down what prepareNetwork created when the sandbox was never created. */
  releaseNetwork?(run: RunRecord): Promise<void>;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  wait(handle: SandboxHandle): Promise<{ exitCode: number | null }>;
  stop(handle: SandboxHandle): Promise<void>;
  remove(handle: SandboxHandle): Promise<void>;
}

/**
 * Turn hierarchical filesystem permissions into a provider-neutral mount plan.
 * The most specific rule wins. Planner runs keep the same visibility but downgrade
 * every writable rule to read-only.
 */
export async function planWorkspaceMounts(run: RunRecord, workspacePath: string, permissions: PermissionSnapshot): Promise<WorkspaceMounts> {
  const empty = { readonly: [] as string[], writable: [] as string[], maskedFiles: [] as string[], maskedDirectories: [] as string[] };
  const declared = permissions.filesystem ?? [];
  if (!declared.length) return { root: run.workspaceAccess === "read_only" ? "ro" : "rw", ...empty };

  const downgrade = (access: "none" | "read" | "read_write") =>
    run.workspaceAccess === "read_only" && access === "read_write" ? "read" : access;
  const byPath = new Map<string, "none" | "read" | "read_write">();
  for (const grant of declared) byPath.set(relativeGrantPath(grant.path), downgrade(grant.access));

  const rootAccess = byPath.get("") ?? "read";
  const root = rootAccess === "none" ? "none" : rootAccess === "read" ? "ro" : "rw";
  const rules = [...byPath.entries()]
    .filter(([relative]) => relative !== "")
    .sort(([left], [right]) => left.length - right.length);

  const resolved: Array<{ relative: string; access: "none" | "read" | "read_write" }> = [];
  const readonly: string[] = [];
  const writable: string[] = [];
  const maskedFiles: string[] = [];
  const maskedDirectories: string[] = [];

  for (const [relative, access] of rules) {
    const absolute = path.resolve(workspacePath, ...relative.split("/"));
    const workspaceRoot = path.resolve(workspacePath);
    if (absolute !== workspaceRoot && !absolute.startsWith(workspaceRoot + path.sep)) {
      throw new Error(`Filesystem grant escapes the workspace: ${relative}`);
    }

    let inherited = rootAccess;
    let inheritedLength = -1;
    for (const rule of resolved) {
      if ((relative === rule.relative || relative.startsWith(`${rule.relative}/`)) && rule.relative.length > inheritedLength) {
        inherited = rule.access;
        inheritedLength = rule.relative.length;
      }
    }
    resolved.push({ relative, access });
    if (access === inherited) continue;

    const info = await stat(absolute).catch(() => undefined);
    if (access === "none") {
      if (inherited === "none" || !info) continue;
      if (info.isDirectory()) maskedDirectories.push(relative);
      else maskedFiles.push(relative);
      continue;
    }

    if (!info) {
      if (access === "read_write") await mkdir(absolute, { recursive: true });
      else continue;
    }
    (access === "read_write" ? writable : readonly).push(relative);
  }

  return { root, readonly: readonly.sort(), writable: writable.sort(), maskedFiles: maskedFiles.sort(), maskedDirectories: maskedDirectories.sort() };
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
