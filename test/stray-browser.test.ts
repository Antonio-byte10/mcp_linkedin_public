// Stray MCP browser after a hard kill of the server: only Playwright's own main process on THIS profile, launcher gone.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { namesProfile, parseProcs, pickStrays, type Proc } from "../src/browser/strayBrowser.js";

// A profile folder written the way the OS writes it (a space in the path on purpose). The command lines below are
// Windows-style on every platform: only the profile folder follows the platform, so this runs the same on CI (Linux).
const DIR = path.resolve(process.platform === "win32" ? "C:/Users/Some User/AppData/Local/mcp-linkedin/edge-profile" : "/home/some user/.mcp-linkedin/edge-profile");
const EXE = `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"`;
const pw = (dir: string, extra = "") => `${EXE} --disable-sync --user-data-dir="${dir}" --remote-debugging-pipe --no-startup-window${extra}`;

test("namesProfile: quoted or not, any slash or case, whole argument only", () => {
  assert.equal(namesProfile(pw(DIR), DIR), true);
  assert.equal(namesProfile(pw(DIR.toUpperCase()), DIR), true);
  assert.equal(namesProfile(`${EXE} --user-data-dir=${DIR.replace(/\\/g, "/")}/ --remote-debugging-pipe`, DIR), true);
  assert.equal(namesProfile(pw(`${DIR}-old`), DIR), false); // a sibling folder with the same prefix
  assert.equal(namesProfile(pw(path.join(DIR, "Default")), DIR), false);
  assert.equal(namesProfile(`${EXE} --remote-debugging-pipe`, DIR), false); // the user's own profile
});

test("pickStrays: Playwright main process on this profile whose launcher is gone", () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 1, cmd: pw(DIR) }, // stray: launcher (pid 1 here) is dead
    { pid: 11, ppid: 10, cmd: pw(DIR, " --type=renderer") }, // a child: ended with the tree, never picked itself
    { pid: 20, ppid: 2, cmd: pw(DIR) }, // the other client's live MCP browser
    { pid: 30, ppid: 1, cmd: pw("C:/x/other-tool/edge-profile") }, // another tool's Playwright browser
    { pid: 40, ppid: 1, cmd: `${EXE} --user-data-dir="${DIR}"` }, // opened by hand on the profile (no pipe)
    { pid: 50, ppid: 1, cmd: `${EXE} --profile-directory=Default` }, // the user's everyday Edge
  ];
  assert.deepEqual(pickStrays(procs, DIR, (pid) => pid === 2), [10]);
  assert.deepEqual(pickStrays(procs, DIR, () => true), []); // every launcher alive: nothing
});

test("parseProcs: tab lines, CRLF, malformed lines dropped", () => {
  assert.deepEqual(parseProcs(`12\t3\ta b\tc\r\n\nbad line\r\n7\t0\t`), [
    { pid: 12, ppid: 3, cmd: "a b\tc" },
    { pid: 7, ppid: 0, cmd: "" },
  ]);
});
