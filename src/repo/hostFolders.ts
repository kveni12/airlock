import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HostFolderEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface HostFolderListing {
  dir: string;
  parent: string | null;
  home: string;
  isGitRepo: boolean;
  entries: HostFolderEntry[];
}

const HIDDEN_ALLOWED = new Set([".config"]);

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Lists the sub-folders of one directory on the machine running the backend so the UI can offer an "Open folder" picker. Files are omitted. */
export async function listHostFolders(dir?: string): Promise<HostFolderListing> {
  const home = os.homedir();
  const target = path.resolve(dir && dir.trim() ? dir : home);
  const dirents = await readdir(target, { withFileTypes: true });
  const folders = dirents.filter((d) => d.isDirectory() && (!d.name.startsWith(".") || HIDDEN_ALLOWED.has(d.name)) && d.name !== "node_modules");
  const entries = await Promise.all(
    folders.map(async (d) => {
      const full = path.join(target, d.name);
      return { name: d.name, path: full, isGitRepo: await isGitRepo(full) };
    })
  );
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { dir: target, parent: parent === target ? null : parent, home, isGitRepo: await isGitRepo(target), entries };
}

/** Opens the operating system's folder dialog on the backend machine (macOS `osascript`, Linux `zenity`). Resolves to `null` when the user cancels. */
export async function pickHostFolder(startDir?: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const start = startDir ? ` default location POSIX file ${JSON.stringify(startDir)}` : "";
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", `POSIX path of (choose folder with prompt "Open a repository for Periscope"${start})`]);
      const chosen = stdout.trim().replace(/\/$/, "");
      return chosen || null;
    } catch (error) {
      if (error instanceof Error && /-128|User canceled/.test(error.message)) return null;
      throw error;
    }
  }
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Open a repository for Periscope", ...(startDir ? [`--filename=${startDir}/`] : [])]);
      return stdout.trim() || null;
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 1) return null;
      throw new Error("No folder dialog available (install zenity) — browse folders in the app instead");
    }
  }
  throw new Error(`Native folder dialog is not supported on ${process.platform} — browse folders in the app instead`);
}

export function nativeFolderDialogAvailable(): boolean {
  return process.platform === "darwin" || (process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
}
