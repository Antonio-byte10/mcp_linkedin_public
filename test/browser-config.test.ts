// Browser config: env parsing, profile paths, stale-lock rule (pure helpers, never launches a browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { legacyDataWarning, parseAutoPurgeDays, parseBrowser, resolveDataDir, resolveProfileDir } from "../src/config.js";

process.env.LINKEDIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-bc-")), "t.db"); // ledger opens a DB on import
const { ACCOUNT_LEVEL } = await import("../src/guard/ledger.js");
const { singletonLockStale } = await import("../src/browser/profileLock.js");

test("singletonLockStale: only this host with a dead pid is stale", () => {
  const alive = (pid: number) => pid === 42;
  assert.equal(singletonLockStale("box-7", "box", alive), true, "dead pid on this host");
  assert.equal(singletonLockStale("box-42", "box", alive), false, "running browser");
  assert.equal(singletonLockStale("other-7", "box", alive), false, "another host: never assume");
  assert.equal(singletonLockStale("my-host-name-7", "my-host-name", alive), true, "hyphenated host names");
  assert.equal(singletonLockStale("garbage", "box", alive), false);
});

test("parseBrowser: mapping table", () => {
  const table: [string | undefined, "edge" | "chrome"][] = [
    [undefined, "edge"],
    ["", "edge"],
    ["edge", "edge"],
    ["msedge", "edge"],
    ["EDGE", "edge"],
    ["chrome", "chrome"],
    ["Chrome", "chrome"],
    [" google-chrome ", "chrome"],
    ["GOOGLE-CHROME", "chrome"],
    ["firefox", "edge"],
    ["chromium", "edge"],
  ];
  for (const [v, want] of table) assert.equal(parseBrowser(v), want, String(v));
});

test("parseAutoPurgeDays: integer 1..3650, anything else is off (0)", () => {
  for (const v of [undefined, "", "0", "abc", "-5", "1.5", "3651", "  "]) assert.equal(parseAutoPurgeDays(v), 0, String(v));
  const on: [string, number][] = [["1", 1], [" 30 ", 30], ["3650", 3650]];
  for (const [v, want] of on) assert.equal(parseAutoPurgeDays(v), want, v);
});

test("resolveDataDir: LINKEDIN_DATA_DIR, else %LOCALAPPDATA%\mcp-linkedin, else ~/.mcp-linkedin", () => {
  assert.equal(resolveDataDir({ LINKEDIN_DATA_DIR: " /custom ", LOCALAPPDATA: "/lad" }, "/home/u"), path.resolve("/custom"));
  assert.equal(resolveDataDir({ LOCALAPPDATA: "/lad" }, "/home/u"), path.join("/lad", "mcp-linkedin"));
  assert.equal(resolveDataDir({ LINKEDIN_DATA_DIR: "  ", LOCALAPPDATA: "" }, "/home/u"), path.join("/home/u", ".mcp-linkedin"));
});

test("legacyDataWarning: only when the code folder still holds old data and is not the data folder", () => {
  const root = path.join("x", "code");
  const has = (names: string[]) => (p: string) => names.some((n) => p === path.join(root, n));
  assert.equal(legacyDataWarning({ root, dataDir: path.join("y", "data"), exists: has([]) }), undefined);
  const w = legacyDataWarning({ root, dataDir: path.join("y", "data"), exists: has(["data", ".edge-profile"]) });
  assert.match(w ?? "", /data, \.edge-profile/);
  assert.match(w ?? "", /npm run migrate-data/);
  assert.equal(legacyDataWarning({ root, dataDir: root, exists: has(["data"]) }), undefined, "data folder set to the code folder");
  // paths the configuration still uses (BROWSER_PROFILE_DIR / LINKEDIN_DATA_DIR pointing there) are not "old data"
  assert.equal(legacyDataWarning({ root, dataDir: path.join(root, "data"), exists: has(["data"]) }), undefined);
  assert.equal(legacyDataWarning({ root, dataDir: path.join("y", "data"), inUse: [path.join(root, ".edge-profile")], exists: has([".edge-profile"]) }), undefined);
});

test("resolveProfileDir: defaults never share a directory", () => {
  const root = path.join("x", "data");
  assert.equal(resolveProfileDir("edge", {}, root), path.join(root, "edge-profile"));
  assert.equal(resolveProfileDir("chrome", {}, root), path.join(root, "chrome-profile"));
});

test("resolveProfileDir: env overrides", () => {
  const root = path.join("x", "data");
  // Legacy EDGE_PROFILE_DIR is Edge only: Chrome must not land in an Edge profile.
  assert.equal(resolveProfileDir("edge", { EDGE_PROFILE_DIR: "/old" }, root), "/old");
  assert.equal(resolveProfileDir("chrome", { EDGE_PROFILE_DIR: "/old" }, root), path.join(root, "chrome-profile"));
  // BROWSER_PROFILE_DIR wins for both, and over the legacy one.
  assert.equal(resolveProfileDir("edge", { BROWSER_PROFILE_DIR: "/new", EDGE_PROFILE_DIR: "/old" }, root), "/new");
  assert.equal(resolveProfileDir("chrome", { BROWSER_PROFILE_DIR: "/new" }, root), "/new");
  // Blank values are ignored.
  assert.equal(resolveProfileDir("edge", { BROWSER_PROFILE_DIR: "  ", EDGE_PROFILE_DIR: "" }, root), path.join(root, "edge-profile"));
});

test("ACCOUNT_LEVEL matches both launch error codes", () => {
  assert.ok(ACCOUNT_LEVEL.test("BROWSER_LAUNCH_FAILED: boom"));
  assert.ok(ACCOUNT_LEVEL.test("BROWSER_LAUNCH_FAILED (likely PROFILE_BUSY): boom"));
  assert.ok(ACCOUNT_LEVEL.test("EDGE_LAUNCH_FAILED: boom"));
  assert.ok(!ACCOUNT_LEVEL.test("SOMETHING_ELSE: boom"));
});
