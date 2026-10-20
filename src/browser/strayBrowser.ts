import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A browser this MCP launched outlives a server that was killed hard (the host closed it on Windows): the window
 * keeps the dedicated profile locked and every later call fails with PROFILE_BUSY. Such a stray is recognised by
 * three things together, so a browser the user opened, the other client's live MCP browser or another tool's
 * Playwright browser (another profile) is never touched:
 * - its command line names THIS profile (--user-data-dir) and Playwright's pipe (--remote-debugging-pipe);
 * - it is the main browser process (no --type=, which marks renderer/GPU/utility children);
 * - the process that launched it is gone (a live MCP server or `npm run browser` keeps it alive).
 * Windows only (where the problem shows up); elsewhere nothing is listed.
 */

export type Proc = { pid: number; ppid: number; cmd: string };

const flat = (s: string) => s.replace(/"/g, "").replace(/\\/g, "/").toLowerCase();

/** --user-data-dir=<dir> as a whole argument (quoted or not, either slash, any case). */
export function namesProfile(cmd: string, profileDir: string): boolean {
  const want = `--user-data-dir=${flat(path.resolve(profileDir)).replace(/\/+$/, "")}`;
  return new RegExp(`(^|\\s)${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(\\s|$)`).test(flat(cmd));
}

/** Main browser processes launched by Playwright on `profileDir` whose launcher is gone. */
export function pickStrays(procs: Proc[], profileDir: string, alive: (pid: number) => boolean): number[] {
  return procs
    .filter((p) => !/(^|\s)--type=/.test(p.cmd) && /(^|\s)--remote-debugging-pipe(\s|$)/.test(p.cmd) && namesProfile(p.cmd, profileDir))
    .filter((p) => !alive(p.ppid))
    .map((p) => p.pid);
}

/** "pid<TAB>ppid<TAB>command line" lines -> Proc[] (malformed lines dropped). */
export function parseProcs(out: string): Proc[] {
  return out.split(/\r?\n/).flatMap((l) => {
    const m = l.match(/^(\d+)\t(\d+)\t(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }] : [];
  });
}

const pidAlive = (pid: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const LIST =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | " +
  "ForEach-Object { [string]$_.ProcessId + \"`t\" + [string]$_.ParentProcessId + \"`t\" + $_.CommandLine }";

/** Running Edge/Chrome processes (Windows). Any failure lists nothing: the caller then reports PROFILE_BUSY as before. */
async function listBrowsers(): Promise<Proc[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return parseProcs(stdout);
  } catch {
    return [];
  }
}

/** Ends the stray browsers on `profileDir` (process tree). Returns the pids it ended. */
export async function closeStrayBrowsers(profileDir: string): Promise<number[]> {
  const ended: number[] = [];
  for (const pid of pickStrays(await listBrowsers(), profileDir, pidAlive)) {
    try {
      await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000, windowsHide: true });
      ended.push(pid);
    } catch {
      // already gone or not ours to end: the lock check after this decides
    }
  }
  return ended;
}
