import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config, type Browser } from "../config.js";
import { profileLocked as isProfileLocked } from "./profileLock.js";
import { closeStrayBrowsers } from "./strayBrowser.js";
import { kvGet } from "../store/db.js";

/**
 * The browser (Edge by default, Chrome via LINKEDIN_BROWSER) is launched by Playwright over a pipe (launchPersistentContext), not a TCP
 * debug port: no other local process can attach to the logged-in session, and we
 * can never attach to some other browser by mistake. The profile in
 * config.profileDir keeps the LinkedIn login between runs. The window lives as
 * long as this MCP process.
 *
 * Headless by default (LINKEDIN_HEADLESS=0 for always-visible). Headless has no window to log in or solve a
 * checkpoint in, so launchBrowser / checkpoint / logged-out recovery relaunch the browser VISIBLE (showWindow) until the idle
 * close; headless uses a desktop viewport so LinkedIn serves the desktop layout the selectors expect.
 */
let ctx: BrowserContext | null = null;
let opening: Promise<BrowserContext> | null = null;
let work: Page | null = null;
let creating: Promise<Page> | null = null;
let headed = false; // the open context is a visible window
let forceHeaded = false; // a login/checkpoint needs the user: keep relaunching visible until the idle close
const NAV_TIMEOUT_MS = 20000; // well under the call budget (the Playwright default of 30 s is the whole budget)

const SHIM = "globalThis.__name = globalThis.__name || ((f) => f);"; // tsx keepNames wraps evaluated fns with __name()

export function browserOpen(): boolean {
  return !!ctx;
}
export const edgeOpen = browserOpen; // legacy name

const IDLE_MIN = Math.max(1, Math.round(config.idleCloseMs / 60000));
const BUSY = () =>
  new Error(
    `PROFILE_BUSY: the MCP ${config.browserName} profile is open in another client (Claude Code / Claude Desktop) or window. ` +
      `It closes itself after ${IDLE_MIN} idle minutes; or close that ${config.browserName} window and retry.`,
  );

const profileLocked = () => isProfileLocked(config.profileDir);

/**
 * The profile is locked: if the lock belongs to a browser a killed MCP server left behind (strayBrowser.ts), end
 * it and wait for the lock to go. true = the profile is free now.
 */
async function freeStrayProfile(): Promise<boolean> {
  const ended = await closeStrayBrowsers(config.profileDir);
  if (!ended.length) return false;
  console.error(`mcp-linkedin: closed ${ended.length} stray ${config.browserName} left by an earlier MCP server on the profile (pid ${ended.join(", ")})`);
  for (let i = 0; i < 20 && profileLocked(); i++) await new Promise((r) => setTimeout(r, 250));
  return !profileLocked();
}

export async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  if (!opening && profileLocked() && !(await freeStrayProfile())) throw BUSY();
  if (ctx) return ctx;
  opening ??= chromium
    .launchPersistentContext(config.profileDir, {
      ...(config.executablePath ? { executablePath: config.executablePath } : { channel: config.channel }),
      headless: config.headless && !forceHeaded,
      viewport: config.headless && !forceHeaded ? { width: 1366, height: 900 } : null,
      locale: "pt-BR",
      timeout: 30000,
      // Drops the "controlled by automated software" flag.
      ignoreDefaultArgs: ["--enable-automation"],
    })
    .then((c) => {
      c.on("close", () => {
        if (ctx !== c) return; // a stale context closing must not orphan a newer one
        ctx = null;
        work = null;
      });
      return c;
    })
    .catch((e: Error) => {
      if (profileLocked()) throw BUSY();
      const lines = e.message.split("\n");
      const busyHint = /has been closed/.test(lines[0]) && /exitCode=0/.test(e.message) ? " (likely PROFILE_BUSY)" : "";
      throw new Error(
        `BROWSER_LAUNCH_FAILED${busyHint}: ${[lines[0], ...lines.slice(-5)].join("\n")}\n` +
          `Make sure ${config.browserName} is installed; set LINKEDIN_BROWSER=chrome|edge to switch browser (or BROWSER_EXECUTABLE_PATH).`,
      );
    })
    .finally(() => (opening = null));
  headed = !(config.headless && !forceHeaded);
  ctx = await opening;
  return ctx;
}

/** goto with a 20 s timeout and a classified error. */
export async function gotoSafe(page: Page, url: string) {
  try {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || /Timeout \d+ms exceeded/.test((e as Error).message)) {
      let where = url;
      try {
        where = new URL(url).pathname;
      } catch {}
      throw new Error(`NAV_TIMEOUT: ${where} did not load within ${NAV_TIMEOUT_MS / 1000} s; LinkedIn or the network is slow, retry shortly.`);
    }
    throw e;
  }
}

/**
 * Makes sure the user can see and use the window (login / checkpoint). In headless mode this closes the headless
 * context and reopens the same profile visible, on `url`. It stays visible until the idle close.
 */
export async function showWindow(url = "https://www.linkedin.com/feed/") {
  if (ctx && headed) return;
  forceHeaded = true;
  await closeContext();
  const p = await getPage();
  await gotoSafe(p, url).catch(() => null);
}

/** Call inside withBrowser. Opens the window on LinkedIn so the user can log in. */
export async function launchBrowser(): Promise<string> {
  const p = await getPage();
  if (kvGet("breaker")) {
    await showWindow();
    return `${config.browserName} open (visible). Automation is SUSPENDED (${kvGet("breaker")}): check LinkedIn in this window yourself, then call session_resume.`;
  }
  await gotoSafe(p, "https://www.linkedin.com/feed/");
  if (isCheckpointUrl(p.url()) || !(await hasSessionCookie())) {
    await showWindow(p.url());
    return `${config.browserName} open (visible window) on the LinkedIn login page: log in there (the window stays open while you do), then call session_status.`;
  }
  return headed ? `${config.browserName} open and logged into LinkedIn.` : `${config.browserName} open (headless) and logged into LinkedIn.`;
}

/** Dedicated working tab; never touches other tabs. */
export async function getPage(): Promise<Page> {
  if (work && !work.isClosed()) return work;
  creating ??= (async () => {
    const c = await getContext();
    // Reuse the blank tab a fresh persistent context opens with.
    const blank = c.pages().find((p) => p.url() === "about:blank");
    const p = blank ?? (await c.newPage());
    await p.addInitScript({ content: SHIM });
    await p.evaluate(SHIM);
    return p;
  })().finally(() => (creating = null));
  work = await creating;
  return work;
}

/**
 * Serializes every browser-driving tool call: they all share one tab, and a
 * concurrent navigation would make one extractor read another tool's page.
 * After IDLE_MS without calls the window is closed, which frees the profile for
 * the other client (Claude Code and Claude Desktop each run their own server).
 */
const IDLE_MS = config.idleCloseMs || 180000;
let chain: Promise<unknown> = Promise.resolve();
let idleTimer: NodeJS.Timeout | null = null;
let callDeadline = 0;

/**
 * Deadline of the running browser call. It is set when the call is enqueued, so
 * queue time and browser cold start count against the host's ~50 s tool timeout.
 */
export function deadline(): number {
  return callDeadline || Date.now() + config.callBudgetMs;
}
/** True while there's room for one more iteration of roughly `needMs`. */
export function hasTime(needMs = 12000): boolean {
  return Date.now() + needMs < deadline();
}

export function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  if (idleTimer) clearTimeout(idleTimer);
  const enqueued = Date.now();
  const task = () => {
    callDeadline = enqueued + config.callBudgetMs;
    return fn();
  };
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  void chain.then(() => {
    callDeadline = 0;
    scheduleIdleClose();
  });
  return run;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // The user may be logging in / solving a checkpoint in the window: don't pull it away.
    if (work && !work.isClosed() && isCheckpointUrl(work.url())) return scheduleIdleClose();
    // Through the chain, so a call arriving mid-close waits instead of seeing a false PROFILE_BUSY.
    chain = chain.then(closeBrowser, closeBrowser);
  }, IDLE_MS);
  idleTimer.unref();
}

async function closeContext() {
  const c = ctx;
  ctx = null;
  work = null;
  await c?.close().catch(() => undefined);
}
export async function closeBrowser() {
  forceHeaded = false; // the next launch is headless again
  await closeContext();
}
// Legacy names.
export const launchEdge = launchBrowser;
export const closeEdge = closeBrowser;

export type SessionState = {
  browser: Browser;
  /** Same value as browser_open; kept for older callers. */
  edge_open: boolean;
  browser_open: boolean;
  logged_in: boolean;
  checkpoint: boolean;
  /** Automation breaker is tripped; nothing was loaded, so logged_in/checkpoint are unknown (reported false). */
  suspended?: boolean;
  url?: string;
};

/** Only the path is checked: keywords/slugs like "challenge" must not trip it. */
function linkedinPath(url: string, re: RegExp) {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/.test(u.hostname) && re.test(u.pathname);
  } catch {
    return false;
  }
}
/** Verification / captcha wall (trips the breaker). */
export const isVerificationUrl = (url: string) => linkedinPath(url, /^\/checkpoint(\/|$)/);
/** Login / auth wall: the session expired or was never created (no breaker, just log in again). */
export const isLoginUrl = (url: string) => linkedinPath(url, /^\/(authwall|uas\/login|login|signup)(\/|$)/);
/** Any page where the user, not the automation, has to act. */
export const isCheckpointUrl = (url: string) => isVerificationUrl(url) || isLoginUrl(url);

async function hasSessionCookie(): Promise<boolean> {
  const c = await getContext();
  return (await c.cookies("https://www.linkedin.com")).some((k) => k.name === "li_at");
}

/** Call inside withBrowser (the server's browserTool does); withBrowser is not reentrant. */
export async function sessionStatus(): Promise<SessionState> {
  // While suspended, don't load LinkedIn at all.
  if (kvGet("breaker")) return { browser: config.browser, edge_open: !!ctx, browser_open: !!ctx, logged_in: false, checkpoint: false, suspended: true, url: "(suspended: not navigating)" };
  const page = await getPage();
  await gotoSafe(page, "https://www.linkedin.com/feed/");
  const url = page.url();
  const checkpoint = isCheckpointUrl(url);
  const logged_in = !checkpoint && (await hasSessionCookie());
  if (!logged_in) await showWindow(url).catch(() => undefined); // headless can't log in: surface the window
  return { browser: config.browser, edge_open: true, browser_open: true, logged_in, checkpoint, url };
}

/** Throws on a login wall / captcha / expired session so callers halt instead of returning empty results. */
export async function assertNoCheckpoint(page: Page) {
  if (isVerificationUrl(page.url())) {
    const url = page.url();
    await showWindow(url).catch(() => undefined);
    throw new Error(
      `CHECKPOINT: LinkedIn is asking for verification (${url}). Resolve it in the MCP ${config.browserName} window (opened visible), then call session_resume. Automation suspended.`,
    );
  }
  if (isLoginUrl(page.url())) {
    await showWindow("https://www.linkedin.com/login").catch(() => undefined);
    throw new Error(`LOGGED_OUT: the LinkedIn session expired. Log in again in the MCP ${config.browserName} window (opened visible), then retry.`);
  }
  if (new URL(page.url()).hostname !== "www.linkedin.com") {
    throw new Error(`LEFT_LINKEDIN: navigation ended on ${new URL(page.url()).hostname}; aborting.`);
  }
  if (!(await hasSessionCookie())) {
    await showWindow("https://www.linkedin.com/login").catch(() => undefined);
    throw new Error(`LOGGED_OUT: no LinkedIn session in the MCP ${config.browserName} profile. Log in in the MCP ${config.browserName} window (opened visible) and retry.`);
  }
}
