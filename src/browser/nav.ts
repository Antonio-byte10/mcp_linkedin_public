import type { Page } from "playwright-core";
import { config } from "../config.js";
import { claimRead, kvGet, kvSet, readCounts, refundRead } from "../store/db.js";
import { jitter, sleep } from "./humanize.js";
import { assertNoCheckpoint, gotoSafe, isVerificationUrl } from "./session.js";

/**
 * Single entry point for page loads. Enforces:
 *  - a global minimum gap between navigations (account-safety pacing),
 *  - a daily read budget per kind,
 *  - a persistent circuit breaker: once LinkedIn shows a checkpoint or answers
 *    429/999, every navigation is refused until the user calls session_resume.
 *    A login redirect (expired session) does NOT trip it: it is reported as LOGGED_OUT and the
 *    user just logs in again. Only /checkpoint (verification/captcha) and 429/999 trip it.
 */
const MIN_GAP_MS = 4000;
const READ_BUDGET: Record<string, number> = { search: 60, profile: 80, company: 80, job: 150, tracker: 30, form: 40, page: 40 };
let lastNav = 0;

export function breakerState(): string | undefined {
  return kvGet("breaker");
}
export function tripBreaker(reason: string) {
  kvSet("breaker", `${new Date().toISOString()} ${reason}`);
}
export function resetBreaker() {
  kvSet("breaker", null);
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}
export function readBudget() {
  const used = readCounts(today());
  return Object.fromEntries(Object.keys(READ_BUDGET).map((k) => [k, { used: used[k] ?? 0, limit: READ_BUDGET[k] }]));
}
/** Atomic (one SQL statement); throws when today's budget for `kind` is used up. */
function countRead(kind: string) {
  if (!claimRead(today(), kind, READ_BUDGET[kind] ?? 40)) {
    throw new Error(`READ_BUDGET: daily limit of ${READ_BUDGET[kind] ?? 40} '${kind}' page loads reached (resets at midnight, America/Sao_Paulo).`);
  }
}

export function assertBreakerClosed() {
  const b = breakerState();
  if (b) throw new Error(`SUSPENDED since ${b}. Check the MCP ${config.browserName} window, then call session_resume.`);
}

/** Paced goto restricted to www.linkedin.com, with breaker + checkpoint checks. */
export async function nav(page: Page, url: string, kind: keyof typeof READ_BUDGET) {
  assertBreakerClosed();
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== "www.linkedin.com") throw new Error(`Refusing to open non-LinkedIn URL: ${url}`);
  countRead(kind);
  const wait = lastNav + MIN_GAP_MS + jitter(0, 2500) - Date.now();
  if (wait > 0) await sleep(wait);
  lastNav = Date.now();
  let resp;
  try {
    resp = await gotoSafe(page, url);
  } catch (e) {
    refundRead(today(), kind); // never reached LinkedIn: don't burn the daily budget
    throw e;
  }
  if (resp && [429, 999].includes(resp.status())) {
    tripBreaker(`http_${resp.status()} on ${u.pathname}`);
    throw new Error(`RATE_LIMITED: LinkedIn answered ${resp.status()}. Automation suspended; wait and call session_resume.`);
  }
  await afterAction(page);
}

/** Re-check after clicks/pagination too (checkpoints can appear without a goto). */
export async function afterAction(page: Page) {
  if (isVerificationUrl(page.url())) tripBreaker(`checkpoint ${safePath(page.url())}`);
  await assertNoCheckpoint(page);
}

function safePath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
