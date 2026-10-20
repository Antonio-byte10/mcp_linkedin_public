import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Project root from this file (works from src/ under tsx and from dist/), never process.cwd():
// MCP hosts start the server in whatever directory is open. It holds code only: everything personal (the logged-in
// browser profile, the database, answers.json, exports) lives in the data folder, outside it (see resolveDataDir).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Numeric env value; unset, empty, blank, NaN, negative or Infinity fall back (Number("") is 0, which must not pass). */
export const num = (v: string | undefined, fallback: number) => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Boolean env value: 0/false/no/off (any case) is false, 1/true/yes/on is true, anything else falls back. */
export const bool = (v: string | undefined, fallback: boolean) => {
  const s = (v ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return fallback;
};

export type Browser = "edge" | "chrome";

/** LINKEDIN_BROWSER value: edge|msedge|chrome|google-chrome (any case); anything else or unset is Edge, the default. */
export const parseBrowser = (v: string | undefined): Browser => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "chrome" || s === "google-chrome" ? "chrome" : "edge";
};

/** LINKEDIN_AUTO_PURGE_DAYS: an integer 1..3650 turns the startup LGPD purge on; unset, empty, 0 or anything else is 0 (off). */
export const parseAutoPurgeDays = (v: string | undefined): number => {
  const s = (v ?? "").trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = Number(s);
  return n >= 1 && n <= 3650 ? n : 0;
};

type Env = Record<string, string | undefined>;
const pick = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/**
 * Data folder (browser profiles, linkedin.db, answers.json, exports, maps): LINKEDIN_DATA_DIR wins; else
 * %LOCALAPPDATA%\mcp-linkedin (outside Windows, ~/.mcp-linkedin). Outside the code folder, so nothing personal goes
 * along when the project is copied or published; on Windows %LOCALAPPDATA% is readable only by the user, SYSTEM and admins.
 */
export const resolveDataDir = (env: Env, home: string): string => {
  const dir = pick(env.LINKEDIN_DATA_DIR);
  if (dir) return path.resolve(dir);
  const local = pick(env.LOCALAPPDATA);
  return local ? path.join(local, "mcp-linkedin") : path.join(home, ".mcp-linkedin");
};

/**
 * Dedicated profile dir. Edge and Chrome never share a default: a profile written by one browser
 * can be rejected (or migrated, breaking the other) by the second one.
 * The legacy EDGE_PROFILE_DIR only applies to Edge.
 */
export const resolveProfileDir = (browser: Browser, env: Env, dataDir: string): string => {
  const legacy = browser === "edge" ? pick(env.EDGE_PROFILE_DIR) : undefined;
  return pick(env.BROWSER_PROFILE_DIR) ?? legacy ?? path.join(dataDir, browser === "edge" ? "edge-profile" : "chrome-profile");
};

/** What lived in the code folder up to 0.5.0, and where each item goes in the data folder (npm run migrate-data). */
export const LEGACY_DATA: { from: string; to: string }[] = [
  { from: "data", to: "." }, // its entries: linkedin.db*, answers.json, exports/, form-maps/, page-maps/, applications/
  { from: ".edge-profile", to: "edge-profile" },
  { from: ".chrome-profile", to: "chrome-profile" },
];

/** Same path, Windows-style (case-insensitive). */
export const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Warning for an install that still has data in the code folder: it is no longer used (a fresh login and an empty
 * database would follow). undefined when there is nothing there or the data folder is the code folder. `inUse` =
 * paths the current configuration points at (data folder, profile, db folder): those are never "old data".
 */
export function legacyDataWarning(o: { root: string; dataDir: string; inUse?: string[]; exists: (p: string) => boolean }): string | undefined {
  if (samePath(o.root, o.dataDir)) return undefined;
  const used = [o.dataDir, ...(o.inUse ?? [])];
  const found = LEGACY_DATA.map((x) => x.from).filter((n) => o.exists(path.join(o.root, n)) && !used.some((u) => samePath(u, path.join(o.root, n))));
  if (!found.length) return undefined;
  return (
    `Data from an older version is still in the code folder (${found.join(", ")}) and is NOT used: the data folder is ${o.dataDir}. ` +
    `Close Claude Desktop/Code (so the browser and the database are free) and run "npm run migrate-data" in the code folder to keep the login and the cache.`
  );
}

const browser = parseBrowser(process.env.LINKEDIN_BROWSER);
const dataDir = resolveDataDir(process.env, os.homedir());
// A typo ("chrom") would otherwise silently open Edge with the Edge profile. stderr: stdout is the MCP channel.
if (process.env.LINKEDIN_BROWSER?.trim() && !/^(edge|msedge|chrome|google-chrome)$/i.test(process.env.LINKEDIN_BROWSER.trim())) {
  console.error(`LINKEDIN_BROWSER="${process.env.LINKEDIN_BROWSER.trim()}" is not edge|msedge|chrome|google-chrome: using Edge.`);
}

const autoPurgeDays = parseAutoPurgeDays(process.env.LINKEDIN_AUTO_PURGE_DAYS);
const autoPurgeRaw = process.env.LINKEDIN_AUTO_PURGE_DAYS?.trim();
if (autoPurgeRaw && autoPurgeRaw !== "0" && !autoPurgeDays) {
  console.error(`LINKEDIN_AUTO_PURGE_DAYS="${autoPurgeRaw}" is not an integer from 1 to 3650: automatic purge stays off.`);
}

export const config = {
  root,
  browser,
  /** For user-facing messages. */
  browserName: browser === "chrome" ? "Chrome" : "Edge",
  /** Playwright channel of the installed browser (ignored when executablePath is set). */
  channel: browser === "chrome" ? "chrome" : "msedge",
  /** BROWSER_EXECUTABLE_PATH launches that binary instead of the installed channel. */
  executablePath: process.env.BROWSER_EXECUTABLE_PATH?.trim() || undefined,
  // Dedicated profile, separate from the user's everyday browser.
  // Log into LinkedIn once in this profile; the session persists.
  profileDir: resolveProfileDir(browser, process.env, dataDir),
  /** Everything personal (resolveDataDir). */
  dataDir,
  // LINKEDIN_DB overrides the database file (tests use a temp file).
  dbPath: pick(process.env.LINKEDIN_DB) ? path.resolve(pick(process.env.LINKEDIN_DB)!) : path.join(dataDir, "linkedin.db"),
  /** The browser runs headless by default; login/checkpoint recovery reopens a visible window. LINKEDIN_HEADLESS=0 keeps it always visible. */
  headless: bool(process.env.LINKEDIN_HEADLESS, true),
  /** Idle time after which the browser window is closed (frees the profile for the other client). EDGE_IDLE_CLOSE_MS is the legacy name. */
  idleCloseMs: num(process.env.BROWSER_IDLE_CLOSE_MS, num(process.env.EDGE_IDLE_CLOSE_MS, 180000)),
  // Conservative defaults; override via env.
  limits: {
    apply_daily: num(process.env.LIMIT_APPLY_DAILY, 25),
    connect_daily: num(process.env.LIMIT_CONNECT_DAILY, 15),
    connect_weekly: num(process.env.LIMIT_CONNECT_WEEKLY, 100),
    message_daily: num(process.env.LIMIT_MESSAGE_DAILY, 20),
  },
  /** Days of absence after which cached people/companies are purged at startup; 0 = off (LINKEDIN_AUTO_PURGE_DAYS). */
  autoPurgeDays,
  pace: { minMs: 1200, maxMs: 3500 },
  /** Wall time per browser tool call, counted from enqueue; loops return partial results before Claude Desktop's ~50 s cutoff. */
  callBudgetMs: num(process.env.CALL_BUDGET_MS, 30000) || 30000, // 0 would make hasTime() always false
};
