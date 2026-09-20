import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

// Only auth.json crosses the container boundary. Never print credential contents.
export function codexAuthCache(directory = path.join(os.homedir(), ".periscope", "codex-auth"), docker = (args, stdio = "ignore") => execFileSync("docker", args, { stdio, timeout: 5000 })) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Codex auth cache must be a real directory.");
  chmodSync(directory, 0o700);
  const lock = path.join(directory, "session.lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch {
    throw new Error(`Another persistent Codex session is active. Close it first. If it crashed, remove ${lock}. Use PERISCOPE_CODEX_PERSIST_LOGIN=0 for a separate login.`);
  }
  const file = path.join(directory, "auth.json");
  return {
    restore(container) {
      if (!existsSync(file)) return false;
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Invalid Codex auth cache file.");
      chmodSync(file, 0o600);
      docker(["exec", container, "mkdir", "-p", "/tmp/.codex"]);
      const input = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        docker(["exec", "-i", container, "sh", "-c", 'umask 077; cat > /tmp/.codex/auth.json'], [input, "ignore", "ignore"]);
      } finally { closeSync(input); }
      return true;
    },
    save(container) {
      const staging = mkdtempSync(path.join(directory, ".save-"));
      try {
        // Reject links rather than copying arbitrary container files.
        docker(["exec", container, "sh", "-c", 'test ! -L /tmp/.codex && test -f /tmp/.codex/auth.json && test ! -L /tmp/.codex/auth.json']);
        const staged = path.join(staging, "auth.json");
        const output = openSync(staged, "wx", 0o600);
        try {
          // docker cp cannot reliably read tmpfs mounts. Stream directly between
          // file descriptors, without capturing tokens in JS or error messages.
          docker(["exec", container, "python3", "-c", 'import os,sys,json; f=os.open("/tmp/.codex/auth.json",os.O_RDONLY|os.O_NOFOLLOW); data=os.read(f,65537); os.close(f); json.loads(data); sys.exit(1) if len(data)>65536 else sys.stdout.buffer.write(data)'], ["ignore", output, "ignore"]);
        } finally { closeSync(output); }
        if (!lstatSync(staged).isFile() || lstatSync(staged).isSymbolicLink()) throw new Error("Invalid auth file");
        chmodSync(staged, 0o600);
        renameSync(staged, file);
        return true;
      } catch { return false; } finally { rmSync(staging, { recursive: true, force: true }); }
    },
    release() { rmSync(lock, { recursive: true, force: true }); }
  };
}
