import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// fs only (no browser, no database): used by the server before launching and by npm run migrate-data.

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/**
 * A SingletonLock left by a crash would read as PROFILE_BUSY forever. It is stale only when it names this
 * host and a pid that is gone; another host (shared profile dir) or an unreadable target stays locked.
 */
export function singletonLockStale(target: string, host: string, alive: (pid: number) => boolean): boolean {
  const m = target.match(/^(.+)-(\d+)$/);
  if (!m || m[1] !== host) return false;
  return !alive(Number(m[2]));
}

/**
 * Is a browser running on `profileDir`? It holds <profile>/lockfile open while running (Windows, Edge and
 * Chrome); Linux/macOS leave a SingletonLock symlink instead. Checking first matters: launching on a busy
 * profile makes the browser forward the request to the running instance (opening a stray window there) and
 * Playwright only reports a generic "browser has been closed".
 */
export function profileLocked(profileDir: string): boolean {
  // readlink, not existsSync: the symlink's target is a "<host>-<pid>" string, so it always dangles.
  let target: string | null = null;
  try {
    target = fs.readlinkSync(path.join(profileDir, "SingletonLock"));
  } catch {}
  if (target !== null && !singletonLockStale(target, os.hostname(), pidAlive)) return true;
  const lock = path.join(profileDir, "lockfile");
  if (!fs.existsSync(lock)) return false;
  try {
    fs.closeSync(fs.openSync(lock, "r+"));
    return false; // stale lock left by a crash
  } catch (e) {
    return ["EBUSY", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "");
  }
}
