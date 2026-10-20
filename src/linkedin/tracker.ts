import type { Page } from "playwright-core";
import { getPage, hasTime } from "../browser/session.js";
import { afterAction, nav } from "../browser/nav.js";
import { jitter, sleep } from "../browser/humanize.js";
import { db, getJob, kvGet, kvSet, markTrackerSeen, upsertJob } from "../store/db.js";
import { confirmUnverifiedApply } from "../guard/ledger.js";
import { cardsByLink } from "./dom.js";

/**
 * Jobs tracker (/jobs-tracker/?stage=applied). 10 cards per page; pagination is
 * client-side only (a "Próxima" button, hidden on the last page; ?start= is ignored),
 * and every visit starts again at page 1.
 * Observed card lines: title, "Company · Location (Modality)", "Candidatou-se há 2 d", "(Anunciada há 3 d)" | "(Não aceita mais candidaturas)", ...
 */
export type Stage = "saved" | "in_progress" | "applied" | "interview" | "archived";

export type TrackedJob = { id: string; title: string; company: string; location: string; when: string; status: string };

/** Closed/unavailable marker inside the (joined) bracket status text. */
export const CLOSED_STATUS = /não aceita mais|no longer/i;

export function parseTrackerCard(href: string, lines: string[]): TrackedJob {
  const id = href.match(/view\/(\d+)/)?.[1] ?? "";
  // "Company · Location (Modality)"; some cards use "•", and a card without a company shows only the location
  // ("Brasil • (Remoto)"), which must not become the company.
  const parts = (lines[1] ?? "").split(/\s+[·•]\s+/).map((s) => s.trim()).filter(Boolean);
  const onlyPlace = parts.length && /\((remoto|h[ií]brido|presencial|remote|hybrid|on-site)\)$/i.test(parts.join(" ")) && (parts.length === 1 || /^\(.*\)$/.test(parts[parts.length - 1]));
  const [company = "", location = ""] = onlyPlace ? ["", parts.join(" ")] : [parts[0] ?? "", parts.slice(1).join(" · ")];
  return {
    id,
    title: lines[0] ?? "",
    company,
    location,
    when: lines.find((l) => /^(Candidatou-se|Applied|Salva|Saved)/i.test(l)) ?? "",
    // Every parenthesised line ("(Anunciada há 3 d)", "(Não aceita mais candidaturas)"), not just the first.
    status: lines
      .filter((l) => /^\(.*\)$/.test(l))
      .map((l) => l.slice(1, -1).trim())
      .join("; "),
  };
}

const PAGE_SIZE = 10;

/** Cards of the current page, deduplicated (each job matches two nested card elements). */
async function readPage(page: Page): Promise<TrackedJob[]> {
  const byId = new Map<string, TrackedJob>();
  for (const c of await page.evaluate(cardsByLink, "/jobs/view/")) {
    const j = parseTrackerCard(c.href, c.lines);
    if (j.id && (!byId.has(j.id) || c.lines.length > 1)) byId.set(j.id, j);
  }
  return [...byId.values()];
}

/** Polls `read` until the first card id differs from `first`. True once the page really changed. */
export async function waitForAdvance(
  read: () => Promise<string | undefined>,
  first: string | undefined,
  tries = 30,
  pause: (ms: number) => Promise<unknown> = sleep,
): Promise<boolean> {
  for (let t = 0; t < tries; t++) {
    await pause(200);
    const now = await read();
    if (now && now !== first) return true;
  }
  return false;
}

export type Advance = "advanced" | "end" | "stalled";

/**
 * Clicks "Próxima" and waits until the first card changes.
 * "end" = the button is really absent/disabled; "stalled" = it was clicked but the page did not change
 * (slow render or blocked) - the caller must NOT treat that as the last page.
 * `expectMore` (the page was full) waits longer for a late-rendering pagination before concluding "end".
 * `fast` (used to skip already-read pages on resume) leaves out the human-like pause.
 */
async function nextPage(page: Page, fast = false, expectMore = false): Promise<Advance> {
  // The button has visible text but no aria-label; the pagination renders a moment after the cards.
  const next = page.locator("main").getByRole("button", { name: /^(Próxima|Next)$/ }).first();
  await next.waitFor({ state: "visible", timeout: 4000 }).catch(() => null);
  if (expectMore && !(await next.isVisible().catch(() => false))) await next.waitFor({ state: "visible", timeout: 4000 }).catch(() => null);
  if (!(await next.isVisible().catch(() => false)) || (await next.isDisabled().catch(() => true))) return "end";
  const first = (await readPage(page))[0]?.id;
  if (!first) return "stalled"; // nothing rendered to compare against
  await next.click({ timeout: 5000 });
  const firstId = async () => (await readPage(page))[0]?.id;
  let ok = await waitForAdvance(firstId, first);
  if (!ok && hasTime(6000)) ok = await waitForAdvance(firstId, first, 20); // one more look before giving up
  if (!ok) return "stalled";
  if (!fast) await sleep(jitter(500, 1100));
  await afterAction(page);
  return "advanced";
}

type Stop = "end" | "known" | "max_pages" | "time_budget" | "stalled";

/**
 * Reads tracker pages; each page is persisted as soon as it is read, together with the resume cursor.
 * - A run cut by the time budget (or a stalled pagination) leaves the cursor; the next call resumes there.
 * - Incremental (default) stops at a page whose jobs were all already seen on the tracker,
 *   but only once a sync has reached the last page at least once.
 * - The sync is only marked complete when the "Próxima" button is really absent/disabled or a short page was
 *   seen, never because a click failed to change the page.
 */
export async function syncTracker(stage: Stage = "applied", maxPages = 15, incremental = true) {
  const kComplete = `tracker:${stage}:complete`;
  const kResume = `tracker:${stage}:resume_page`;
  const complete = kvGet(kComplete) === "1";
  const skip = Number(kvGet(kResume) ?? 0) || 0;

  const page = await getPage();
  await nav(page, `https://www.linkedin.com/jobs-tracker/?stage=${stage}`, "tracker");
  await page.waitForSelector("main a[href*='/jobs/view/']", { timeout: 8000 }).catch(() => null);
  await afterAction(page);

  let pageNo = 0;
  let stopped: Stop = "max_pages";
  let skipping = true;
  // Skip pages read by an earlier call. Cheap clicks, but each must fit the time budget (the cursor is kept as is).
  while (pageNo < skip) {
    if (!hasTime(5000)) {
      stopped = "time_budget";
      break;
    }
    const r = await nextPage(page, true, true);
    if (r === "stalled") {
      stopped = "stalled";
      break;
    }
    if (r === "end") break; // the list got shorter than the cursor: read from here
    pageNo++;
  }
  skipping = stopped === "max_pages";

  const all = new Map<string, TrackedJob>();
  for (let read = 0; skipping && read < maxPages; read++) {
    let onPage = await readPage(page);
    if (onPage.length < PAGE_SIZE) {
      await sleep(800); // a late-rendering page must not look like the last one
      const again = await readPage(page);
      if (again.length > onPage.length) onPage = again;
    }
    const fresh = onPage.filter((j) => !all.has(j.id));
    if (!fresh.length) {
      stopped = "stalled"; // nothing new on a page we just advanced to: not proof of the end
      break;
    }
    let alreadySeen = 0;
    for (const j of fresh) {
      all.set(j.id, j);
      if (stage !== "applied") continue;
      if (getJob(j.id)?.tracker_seen === 1) alreadySeen++;
      upsertJob({
        id: j.id, title: j.title, company: j.company, location: j.location, url: `https://www.linkedin.com/jobs/view/${j.id}/`,
        applied: 1, closed: CLOSED_STATUS.test(j.status) ? 1 : 0,
      });
      markTrackerSeen(j.id);
      // an apply that could not be confirmed (status unverified) is confirmed by LinkedIn's own tracker
      confirmUnverifiedApply(db, j.id);
    }
    pageNo++;
    if (stage === "applied" && incremental && complete && alreadySeen === fresh.length) {
      stopped = "known";
      break;
    }
    if (onPage.length < PAGE_SIZE) {
      stopped = "end"; // a short page is the last one
      break;
    }
    kvSet(kResume, String(pageNo)); // persisted per page: a call cut by the host keeps its progress
    if (!hasTime(4000)) {
      stopped = "time_budget";
      break;
    }
    const r = await nextPage(page, false, true);
    if (r === "end") {
      stopped = "end";
      break;
    }
    if (r === "stalled") {
      stopped = "stalled";
      break;
    }
  }
  if (stopped === "end") {
    kvSet(kComplete, "1");
    kvSet(kResume, null);
  } else if (stopped === "known") {
    kvSet(kResume, null);
  } else if (stopped === "max_pages" && pageNo > skip) {
    kvSet(kResume, String(pageNo));
  }
  return {
    stage,
    pages_read_this_call: Math.ceil(all.size / PAGE_SIZE),
    reached_page: pageNo,
    stopped,
    full_sync_done: stopped === "end" || complete,
    note:
      stopped === "time_budget"
        ? "Time budget reached; call tracker_sync again to continue from this page."
        : stopped === "stalled"
          ? "The next tracker page did not load (slow render or blocked); the sync is NOT marked complete. Call tracker_sync again to retry from this page."
          : undefined,
    total: all.size,
    jobs: all.size > 30 ? undefined : [...all.values()],
  };
}
