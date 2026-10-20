/**
 * Messages to 1st-degree connections (message_prepare / message_execute). Validated on the live 2026 UI
 * (dry run and real sends verified in the conversation). Every check still fails closed and
 * the in-page code only reports what it sees; decisions are in messageRules.ts (unit-tested).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "playwright-core";
import { afterAction, nav } from "../browser/nav.js";
import { pause } from "../browser/humanize.js";
import { getPage, hasTime } from "../browser/session.js";
import { config } from "../config.js";
import { ACCOUNT_LEVEL, MESSAGE_REPEAT_DAYS, TYPED_REASON, checkItems, claimItems, newBatch, parseBatch, recentMessageIn, type BatchData } from "../guard/ledger.js";
import { clip } from "../guard/untrusted.js";
import { mainLines } from "./dom.js";
import {
  DISCARD_RE,
  SEND_FAILED_RE,
  cleanMessageInput,
  closeButton,
  closeDecision,
  composerToClose,
  degreeOnPage,
  diagComposers,
  diagMessageControls,
  findMessageControl,
  isEmptyBox,
  isFirstDegreeLabel,
  messagingOverlayState,
  messageTextPlan,
  pickComposer,
  sameMessageText,
  sendButton,
  sendVerified,
  textHash,
  type ComposerSnap,
  type ConvMessage,
} from "./messageRules.js";
import { readConversation, snapshotComposers } from "./messageDom.js";
import { cachedPersonIn, profileName, snapshot } from "./people.js";
import { isPlaceholderName, normaliseProfileId, pollUntil, profileSlug, profileTargetCheck } from "./writeRules.js";

// ---- prepare (local) ----

export type MessageCandidate = { id: string; name?: string; headline?: string; degree?: string; verify_note?: string };

/**
 * message_prepare: normalises and dedupes the ids, rejects profiles cached as not 1st-degree and those
 * messaged in the last MESSAGE_REPEAT_DAYS days, caps at the remaining quota, and stores the cleaned text
 * plus its SHA-256 in the batch meta (the only text message_execute will ever type). Sends nothing.
 */
export function prepareMessageBatch(d: DatabaseSync, a: { profile_ids: string[]; text: string }, o: { remaining: number; ttlMin: number }) {
  const text = cleanMessageInput(a.text);
  const seen = new Set<string>();
  const rejected: { input: string; reason: string }[] = [];
  const cands: MessageCandidate[] = [];
  for (const raw of a.profile_ids) {
    const id = normaliseProfileId(raw);
    if (!id) {
      rejected.push({ input: clip(raw, 120), reason: "not a linkedin.com/in/<slug> URL or slug" });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const p = cachedPersonIn(d, id);
    if (p?.degree?.trim() && !isFirstDegreeLabel(p.degree)) {
      rejected.push({ input: id, reason: `not_connected (cached degree ${clip(p.degree, 20)}; messages go to 1st-degree connections only)` });
      continue;
    }
    const prior = recentMessageIn(d, id);
    if (prior) {
      rejected.push({ input: id, reason: `already messaged in the last ${MESSAGE_REPEAT_DAYS} days (${prior})` });
      continue;
    }
    if (cands.length >= o.remaining) {
      rejected.push({ input: id, reason: "over_quota" });
      continue;
    }
    cands.push({
      id,
      name: p?.name ? clip(p.name, 120) : undefined,
      headline: p?.headline ? clip(p.headline, 200) : undefined,
      degree: p?.degree ? clip(p.degree, 20) : undefined,
      verify_note: p?.degree?.trim() ? undefined : "degree not in the local cache: will be verified on the page (not 1st-degree = not sent)",
    });
  }
  if (!cands.length) return { batch_id: null, quota_remaining: o.remaining, candidates: [], rejected };
  const names = Object.fromEntries(cands.filter((c) => c.name).map((c) => [c.id, c.name as string]));
  const sha = textHash(text);
  const batchId = newBatch(d, "message", cands.map((c) => c.id), { names, text, text_sha256: sha });
  return {
    batch_id: batchId, expires_in_min: o.ttlMin, quota_remaining: o.remaining, candidates: cands,
    rejected: rejected.length ? rejected : undefined,
    text, text_chars: text.length, text_sha256: sha,
    note:
      "Show the USER the candidates and the exact text above. message_execute runs a dry run by default (opens and closes each composer, types nothing); " +
      "sending needs dry_run:false." + (cands.some((c) => !c.name) ? " Profiles without a name are not in the local cache (run people_search first to verify who they are)." : ""),
  };
}

/**
 * Gate of message_execute, in this order: the batch exists, its stored text passes the SHA-256 check (a
 * mismatch throws before the batch is touched, so it is never burnt), then a dry run only checks the ids
 * (nothing claimed, no quota) while a real run claims them against the quota.
 */
export function messageExecutePlan(
  d: DatabaseSync,
  a: { batchId: string; ids: string[]; dryRun: boolean },
  o: { ttlMin: number; quotaLeft: () => number },
): { text: string; batch: BatchData } {
  const row = d.prepare(`SELECT items FROM batches WHERE id=? AND kind='message'`).get(a.batchId) as { items: string } | undefined;
  if (!row) throw new Error("Unknown batch_id. Run message_prepare first.");
  const text = messageTextPlan(parseBatch(row.items).meta);
  const claim = { batchId: a.batchId, kind: "message", ids: a.ids, ttlMin: o.ttlMin, prepareTool: "message_prepare" };
  return { text, batch: a.dryRun ? checkItems(d, claim) : claimItems(d, { ...claim, quotaLeft: o.quotaLeft }) };
}

// ---- execute (browser) ----

export type MessageOptions = {
  /** The batch text (messageTextPlan): never from the execute call. */
  text: string;
  /** Name the user saw in message_prepare (people cache); the profile's name must match it. */
  expectedName?: string;
  /** Open the composer, verify the recipient, close it; nothing typed. */
  dryRun: boolean;
};
export type MessageResult = {
  success: boolean;
  /** done = the conversation shows the text as the user's last message; unverified = Send clicked, not confirmed. */
  status: "done" | "failed" | "unverified" | "skipped" | "dry_run_ok";
  reason?: string;
  detail?: string;
  name?: string;
  /** Composer left open / partial send / account-level problem: the caller stops the batch. */
  stop?: string;
  diag?: string;
};

const msgFail = (reason: string, extra: Partial<MessageResult> = {}): MessageResult => ({ success: false, status: "failed", reason, ...extra });
/** Reasons that can still change while the composer renders. */
const TRANSIENT = new Set(["composer_not_found", "recipient_mismatch"]);

const snapComposers = (page: Page) => page.evaluate(snapshotComposers).catch(() => [] as ComposerSnap[]);
const readConv = (page: Page, i: number) => page.evaluate(readConversation, i).catch(() => ({ messages: [] as ConvMessage[], alert: "" }));
const boxValue = (box: Locator) =>
  box.evaluate((e) => (e instanceof HTMLTextAreaElement ? e.value : (e as HTMLElement).innerText) ?? "").catch(() => "");

/**
 * Closes the composer addressed to `name` (else the one the click focused, once). With `clear`, text in
 * the person's composer (only ever ours: typing needs an empty box) is deleted first. On the /messaging
 * page there is nothing to close: an empty box is clean. False = it could not be closed cleanly, which
 * with `clear` includes "the composer typed into cannot be identified" (closeDecision).
 */
async function closeComposer(page: Page, name: string, clear: boolean): Promise<boolean> {
  let fallbackTried = false;
  let namedSeen = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const pick = composerToClose(await snapComposers(page), name);
    const decision = closeDecision(pick, { clear, namedSeen, fallbackTried });
    if (decision !== "act") return decision === "closed";
    if (!pick || pick === "ambiguous") return false; // unreachable: closeDecision acts only on a composer
    const { s, named } = pick;
    // The unnamed fallback is tried once and never cleared (it may be another conversation).
    if (named) namedSeen = true;
    else fallbackTried = true;
    const box = page.locator(`[data-mcp-box="${s.i}"]`).first();
    if (named && clear && !isEmptyBox(s.boxText)) {
      await box.click({ timeout: 3000 }).catch(() => null);
      await page.keyboard.press("ControlOrMeta+A").catch(() => null);
      await page.keyboard.press("Delete").catch(() => null);
      await pause(300, 600);
      continue; // re-read: closing only once the box is verifiably empty
    }
    // /messaging page: nothing to close. Clean = the named box is empty; a typed run cannot vouch for another one.
    if (s.fullPage) return named || !clear;
    const x = closeButton(s);
    if (x) await page.locator(`[data-mcp-b="${s.i}-${x.k}"]`).first().click({ timeout: 3000 }).catch(() => null);
    else {
      await box.click({ timeout: 3000 }).catch(() => null);
      await page.keyboard.press("Escape").catch(() => null);
    }
    await pause(500, 900);
    // A "discard message?" prompt only concerns a box this run emptied.
    if (named && clear) {
      const discard = page.locator("[role=dialog], [role=alertdialog], dialog[open]").getByRole("button", { name: DISCARD_RE });
      if ((await discard.count().catch(() => 0)) === 1) await discard.click({ timeout: 3000 }).catch(() => null);
    }
  }
  return false;
}

/**
 * Sends the batch text to one 1st-degree connection, on THEIR profile's message control only. Checks, in order:
 * - the page is the prepared /in/ profile (vanity slug, or the cached name for opaque ids);
 * - the page shows a 1st-degree connection (else not_connected, nothing clicked);
 * - the message control names this person and is not an InMail/Premium upsell (else inmail_refused);
 * - the composer that opens names exactly this person, has one empty box and no upsell wording;
 * dry run stops here and closes the composer. A real run types the text (Shift+Enter between lines, never
 * Enter), reads it back, re-checks the recipient, clicks the single Send, then re-reads the conversation:
 * done only when the user's last message there is this text and new; otherwise unverified.
 * A composer that cannot be closed cleanly after a failure stops the batch (DISCARD_FAILED).
 */
export async function executeMessage(url: string, opts: MessageOptions): Promise<MessageResult> {
  const target = normaliseProfileId(url);
  if (!target) return msgFail("invalid_profile_url");
  const text = opts.text;
  if (!text.trim()) return msgFail("empty_text");
  const slug = profileSlug(target)!;
  const expected = opts.expectedName && !isPlaceholderName(opts.expectedName) ? opts.expectedName : undefined;
  const page = await getPage();
  let name = "";
  let opened = false; // the message control was clicked: a composer may be open
  let typed = false; // text went into the box
  let sent = false; // Send was clicked

  const finish = async (r: MessageResult): Promise<MessageResult> => {
    if (!opened) return r;
    const closed = await closeComposer(page, name || expected || "", typed).catch(() => false);
    if (closed || r.status === "done") return r; // after a verified send the box is empty: nothing unsent is left
    const stop =
      `DISCARD_FAILED: the message composer${name ? ` for ${name}` : ""} may still be open in the MCP ${config.browserName} window` +
      (typed ? " and may still hold the typed text: delete it (do not send it) and close it there." : ". Close it there.");
    return r.status === "dry_run_ok" ? msgFail("composer_not_closed", { name, stop }) : { ...r, stop: r.stop ?? stop };
  };
  const diag = async () => {
    const controls = diagMessageControls(await snapshot(page), name || expected || "");
    // overlay host state: a closed (unreadable) shadow root would explain composers=0
    const host = await page
      .evaluate(() => {
        const h = document.querySelector("#interop-outlet");
        return h ? (h.shadowRoot ? `open(${h.shadowRoot.querySelectorAll("[contenteditable=true], textarea").length} boxes)` : "closed") : "none";
      })
      .catch(() => "?");
    return [controls, opened ? `${diagComposers(await snapComposers(page))} interop=${host}` : ""].filter(Boolean).join(" || ");
  };
  // After typing every failure reason carries TYPED_REASON: it then blocks a repeat like a sent message.
  const fail = async (reason: string, extra: Partial<MessageResult> = {}) => {
    const d = await diag().catch(() => "");
    return finish(msgFail(typed ? `${TYPED_REASON}${reason}` : reason, { name: name || undefined, diag: d || undefined, ...extra }));
  };

  try {
    await nav(page, target, "profile");
    await page.locator("main").first().waitFor({ timeout: 8000 }).catch(() => null);
    await afterAction(page);
    await pause(800, 1500);
    if (!profileSlug(page.url())) return await fail("redirected_away_from_profile");
    name = clip(await profileName(page), 120);
    if (!name) return await fail("profile_name_not_found");
    const wrong = profileTargetCheck({ slug, pageUrl: page.url(), h1: name, expected });
    if (wrong) return await fail(wrong);
    const landed = profileSlug(page.url()) ?? slug;

    const controls = await snapshot(page);
    const top = (await page.evaluate(mainLines).catch(() => [] as string[])).slice(0, 30);
    const degree = degreeOnPage(controls, top, name, landed);
    if (degree !== "1st") {
      return await fail("not_connected", { detail: degree === "unknown" ? "no 1st-degree marker found on the profile" : "the profile shows a 2nd/3rd degree, Pending or Connect state" });
    }
    const found = findMessageControl(controls, name, landed);
    if ("reason" in found) return await fail(found.reason);
    // The overlay app must be mounted before the click: one landing while #interop-outlet is still an empty shell
    // is swallowed and no composer ever opens. No outlet at all after the wait = a layout where the link navigates.
    const overlayReady = await pollUntil(async () => ((await page.evaluate(messagingOverlayState).catch(() => "none")) === "ready" ? true : null), 8000, 400);
    if (!overlayReady && (await page.evaluate(messagingOverlayState).catch(() => "none")) === "loading") return await fail("messaging_overlay_not_ready");
    const btn = page.locator(`[data-mcp-c="${found.i}"]`).first();
    if (!(await btn.count())) return await fail("message_control_vanished");
    opened = true;
    await btn.click({ timeout: 5000 });
    await pause(1000, 1600);
    await afterAction(page);
    if (/\/(premium|sales)\//i.test(page.url())) return await fail("inmail_refused");

    const pick =
      (await pollUntil(async () => {
        const p = pickComposer(await snapComposers(page), name);
        return "reason" in p && TRANSIENT.has(p.reason) ? null : p;
      }, 6000, 500)) ?? pickComposer(await snapComposers(page), name);
    if ("reason" in pick) return await fail(pick.reason);
    // Someone's unsent draft is theirs: never typed into, never cleared.
    if (!isEmptyBox(pick.boxText)) return await fail("composer_has_draft");
    if (opts.dryRun) return await finish({ success: false, status: "dry_run_ok", name });

    if (!hasTime(15000)) return await fail("time_budget");
    // The history may still be loading: an empty baseline would let an old identical message read as "sent".
    // Baseline = two equal reads in a row (count + last text), else the last read after 3 s.
    let prevKey: string | null = null;
    const before =
      (await pollUntil(async () => {
        const c = await readConv(page, pick.i);
        const key = `${c.messages.length}|${c.messages.at(-1)?.text ?? ""}`;
        const settled = key === prevKey;
        prevKey = key;
        return settled ? c : null;
      }, 3000, 500)) ?? (await readConv(page, pick.i));
    const box = page.locator(`[data-mcp-box="${pick.i}"]`).first();
    await box.click({ timeout: 3000 });
    // the box's own root: inside the overlay's shadow root document.activeElement is only the host
    const focused = await box
      .evaluate((e) => {
        const a = (e.getRootNode() as Document | ShadowRoot).activeElement;
        return !!a && (e === a || e.contains(a));
      })
      .catch(() => false);
    if (!focused) return await fail("composer_box_not_focused");
    typed = true;
    const lines = text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      if (k) {
        await page.keyboard.press("Shift+Enter");
        // Shift+Enter is a line break; an emptied box means a part went out: never go on.
        if (lines.slice(0, k).some((l) => l.trim()) && isEmptyBox(await boxValue(box))) {
          sent = true;
          return await finish({
            success: false, status: "unverified", reason: "possible_partial_send", name,
            stop: `PARTIAL_SEND: part of the message to ${name} may have been sent. Check the conversation in the MCP ${config.browserName} window.`,
          });
        }
      }
      if (lines[k]) await page.keyboard.insertText(lines[k]);
    }
    await pause(300, 600);
    if (!sameMessageText(await boxValue(box), text)) return await fail("text_mismatch");

    // Right before Send: still this person's composer, still exactly the text, one enabled Send.
    const again = pickComposer(await snapComposers(page), name);
    if ("reason" in again) return await fail(again.reason);
    if (!sameMessageText(again.boxText, text)) return await fail("text_mismatch");
    const send = sendButton(again);
    if (!send) return await fail("send_unavailable");
    if (send.disabled) return await fail("send_disabled");
    sent = true; // from here the message may be out: only done or unverified
    await page.locator(`[data-mcp-b="${again.i}-${send.k}"]`).first().click({ timeout: 5000 });
    await pause(1200, 1800);
    await afterAction(page);

    // Re-read the conversation (upsell wording no longer matters: the user's own text is in it now).
    const seen = await pollUntil(async () => {
      const s = pickComposer(await snapComposers(page), name, { upsell: false });
      if ("reason" in s) return null;
      const conv = await readConv(page, s.i);
      if (SEND_FAILED_RE.test(conv.alert)) return "send_error_shown" as const;
      return sendVerified(before.messages, conv.messages, text, name, s.boxText) ? ("ok" as const) : null;
    }, 8000, 800);
    if (seen === "ok") return await finish({ success: true, status: "done", name });
    return await finish({ success: false, status: "unverified", reason: seen ?? "sent_message_not_seen", name, diag: diagComposers(await snapComposers(page)) });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    const account = ACCOUNT_LEVEL.test(msg);
    // On a checkpoint/limit page nothing more is clicked; the stop tells the user.
    if (sent) {
      const r: MessageResult = { success: false, status: "unverified", reason: `unverified: ${clip(msg, 200)}`, name: name || undefined, stop: account ? msg : undefined };
      return account ? r : await finish(r);
    }
    if (typed) {
      const r = msgFail(`${TYPED_REASON}exception: ${clip(msg, 200)}`, {
        name: name || undefined, stop: account ? msg : undefined,
        detail: account ? `the composer may still hold the typed text: delete it in the MCP ${config.browserName} window` : undefined,
      });
      return account ? r : await finish(r);
    }
    if (account) throw e; // nothing typed: the item reopens (ledger.reopens)
    return await finish(msgFail(clip(msg, 300), { name: name || undefined }));
  }
}
