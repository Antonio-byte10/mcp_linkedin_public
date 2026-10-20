import type { Page } from "playwright-core";
import type { DatabaseSync } from "node:sqlite";
import { getPage, hasTime } from "../browser/session.js";
import { afterAction, nav, tripBreaker } from "../browser/nav.js";
import { pause } from "../browser/humanize.js";
import { ACCOUNT_LEVEL } from "../guard/ledger.js";
import { clip } from "../guard/untrusted.js";
import { db } from "../store/db.js";
import { cardsByLink, mainLines } from "./dom.js";
import { ACTIONS, isMutualText, parsePersonCard, splitCurrent, type Person } from "./peoplePure.js";
import {
  ADD_NOTE_RE,
  EMAIL_REQUIRED_RE,
  INVITE_MODAL_RE,
  INVITE_SENT_RE,
  NOTE_LIMIT_RE,
  NOTE_MAX,
  SEND_NO_NOTE_RE,
  SEND_RE,
  WEEKLY_LIMIT_RE,
  classifyProfile,
  diagControls,
  findConnectControl,
  inviteHrefSlug,
  nameFromTitle,
  isPlaceholderName,
  pollUntil,
  profileTargetCheck,
  normaliseProfileId,
  profileSlug,
  type PageControl,
} from "./writeRules.js";

export type PeopleSearchParams = {
  keywords: string;
  network?: ("1st" | "2nd" | "3rd")[];
  geo_urn?: string; // e.g. 106057199 = Brazil
  current_company_ids?: string[];
  limit?: number;
};

const NET = { "1st": "F", "2nd": "S", "3rd": "O" } as const;

export function buildPeopleUrl(p: PeopleSearchParams, page = 1) {
  const q = new URLSearchParams({ keywords: p.keywords });
  if (p.network?.length) q.set("network", JSON.stringify(p.network.map((n) => NET[n])));
  if (p.geo_urn) q.set("geoUrn", JSON.stringify([p.geo_urn]));
  if (p.current_company_ids?.length) q.set("currentCompany", JSON.stringify(p.current_company_ids));
  if (page > 1) q.set("page", String(page));
  return `https://www.linkedin.com/search/results/people/?${q}`;
}

export { parsePersonCard, splitCurrent, type Person };

export async function searchPeople(p: PeopleSearchParams): Promise<Person[]> {
  const page = await getPage();
  const limit = p.limit ?? 20;
  const out = new Map<string, Person>();
  for (let n = 1; out.size < limit && n <= 5 && (n === 1 || hasTime()); n++) {
    await nav(page, buildPeopleUrl(p, n), "search");
    await page.waitForSelector("main a[href*='/in/']", { timeout: 8000 }).catch(() => null);
    await afterAction(page);
    await page.waitForTimeout(1500);
    const cards = await page.evaluate(cardsByLink, "/in/");
    const before = out.size;
    for (const c of cards) {
      if (!c.href.includes("/in/")) continue;
      const person = parsePersonCard(c.href, c.lines, [...c.buttons, ...c.linkLabels]);
      // one key per person in results and cache (cards link "/in/<slug>/pt" or carry tracking params)
      person.url = normaliseProfileId(person.url) ?? person.url;
      if (person.name) out.set(person.url, person);
    }
    if (out.size === before) break;
  }
  const people = [...out.values()].slice(0, limit);
  savePeople(people);
  return people;
}

/** Upsert that never replaces cached data with an empty value (a card that parsed fewer fields keeps the old ones). */
export function savePeople(people: Person[]) {
  const up = db.prepare(
    `INSERT INTO people (url,name,headline,company,role,location,degree,last_seen) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(url) DO UPDATE SET last_seen=CURRENT_TIMESTAMP, name=COALESCE(NULLIF(excluded.name,''),name), headline=COALESCE(NULLIF(excluded.headline,''),headline),
       company=COALESCE(NULLIF(excluded.company,''),company), role=COALESCE(NULLIF(excluded.role,''),role),
       location=COALESCE(NULLIF(excluded.location,''),location), degree=COALESCE(NULLIF(excluded.degree,''),degree)`,
  );
  people.forEach((x) => up.run(normaliseProfileId(x.url) ?? x.url, x.name, x.headline, x.company, x.role, x.location, x.degree));
}

export type CachedPerson = { name: string | null; headline: string | null; degree: string | null };

/** Cached people row for a normalised /in/ URL (stored urls may carry query strings or other spellings). */
export function cachedPersonIn(d: DatabaseSync, id: string): CachedPerson | undefined {
  const slug = id.slice("https://www.linkedin.com/in/".length, -1);
  const rows = d
    // exact (normalised) row first, then the shortest spellings, so a longer slug sharing the prefix can't crowd it out
    .prepare(`SELECT url,name,headline,degree FROM people WHERE url LIKE ? ORDER BY url = ? DESC, length(url) LIMIT 20`)
    .all(`%/in/${slug}%`, id) as ({ url: string } & CachedPerson)[];
  const r = rows.find((x) => normaliseProfileId(x.url) === id);
  return r ? { name: r.name, headline: r.headline, degree: r.degree } : undefined;
}

/** Top-card + About of a profile. Observed lines: name, degree, headline, location, "Dados de contato", company, school, connections... */
export async function getProfile(url: string) {
  const page = await getPage();
  await nav(page, url, "profile");
  await page.waitForTimeout(2500);
  await afterAction(page);
  const lines = await page.evaluate(mainLines);
  const contactIdx = lines.findIndex((l) => /^(Dados de contato|Contact info)$/.test(l));
  const aboutIdx = lines.findIndex((l) => /^(Sobre|About)$/.test(l));
  const endAbout = lines.findIndex((l, i) => i > aboutIdx && /^(Em destaque|Featured|Atividades|Activity|Experiência|Experience)$/.test(l));
  const connIdx = lines.findIndex((l) => /conexões|connections|seguidores|followers/i.test(l));
  return {
    url: page.url().split("?")[0],
    name: lines[0] ?? "",
    degree: lines.find((l) => /^•\s*\d/.test(l))?.replace(/^•\s*/, "") ?? "",
    headline: lines[2] ?? "",
    location: contactIdx > 0 ? lines[contactIdx - 1].replace(/^·$/, lines[contactIdx - 2] ?? "") : "",
    top_company_and_school: contactIdx > 0 && connIdx > contactIdx ? lines.slice(contactIdx + 1, connIdx).filter((l) => !/^mais de|^\d/.test(l)) : [],
    connections: connIdx >= 0 ? `${lines[connIdx - 1] ?? ""} ${lines[connIdx]}`.trim() : "",
    mutual: lines.find(isMutualText) ?? "",
    actions: lines.filter((l) => ACTIONS.test(l)).slice(0, 4),
    about: aboutIdx >= 0 ? lines.slice(aboutIdx + 1, endAbout > aboutIdx ? endAbout : aboutIdx + 15).join("\n") : "",
  };
}
// ---- connect (write) ----

export type ConnectOptions = {
  note?: string;
  /** Name the user saw in connect_prepare (people cache); the profile's name (page title) must match it. */
  expectedName?: string;
};
export type ConnectResult = {
  success: boolean;
  /** done = invite verified (Pending / "invitation sent"); unverified = Send clicked, not confirmed; skipped = nothing to do. */
  status: "done" | "failed" | "unverified" | "skipped";
  reason?: string;
  name?: string;
  /** Account-level problem (weekly limit, checkpoint, note quota): the caller stops the batch. */
  stop?: string;
  /** On failure: labels/hrefs of up to 15 relevant page controls (for iterating against the live UI). */
  diag?: string;
  /** false = a note was approved but LinkedIn sent the invite on the first click, without it (`warning` says so). */
  note_sent?: boolean;
  warning?: string;
};

const connectFail = (reason: string, extra: Partial<ConnectResult> = {}): ConnectResult => ({ success: false, status: "failed", reason, ...extra });

const OVERLAYS = "[role=dialog], dialog[open], [role=alertdialog]";
/**
 * Open overlays only: the 2026 profile keeps hidden ad-menu dialogs in the page, and the invite modal lives in the
 * #interop-outlet shadow root (Playwright CSS pierces it), so "the last dialog" is often a hidden one.
 */
const shownOverlays = (page: Page) => page.locator(OVERLAYS).filter({ visible: true });
/** The visible invite dialog ("Adicionar nota" / "Enviar sem nota"). */
export const inviteDialog = (page: Page) => shownOverlays(page).filter({ hasText: INVITE_MODAL_RE }).last();
const overlayText = async (page: Page) => (await shownOverlays(page).allInnerTexts().catch(() => [] as string[])).join("\n");

/** Closes open invite/limit dialogs without sending (dismiss button, else Escape). */
async function closeOverlays(page: Page) {
  for (let i = 0; i < 2; i++) {
    const close = shownOverlays(page).locator("button[aria-label='Fechar'], button[aria-label='Dismiss'], button[aria-label='Close']").filter({ visible: true }).first();
    if (await close.count().catch(() => 0)) await close.click({ timeout: 3000 }).catch(() => null);
    else await page.keyboard.press("Escape").catch(() => null);
    await pause(300, 600);
    if (!(await shownOverlays(page).count().catch(() => 0))) return;
  }
}

/**
 * Runs in the page. Every clickable control (links, buttons, menu items) in <main> and in open menus/dialogs,
 * stamped data-mcp-c=<i> so the chosen one can be clicked by index. Only labels/hrefs/componentkeys are read:
 * class names are hashed and the 2026 profile has no <h1> and no stable top-card section.
 */
function snapshotControls(): PageControl[] {
  document.querySelectorAll("[data-mcp-c]").forEach((e) => e.removeAttribute("data-mcp-c"));
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => !!((e as HTMLElement).offsetParent || e.getClientRects().length);
  const menus = "[role=menu], [role=listbox], .artdeco-dropdown__content--is-open, [role=dialog], dialog[open]";
  const seen = new Set<Element>();
  const out: PageControl[] = [];
  const roots = [document.querySelector("main"), ...document.querySelectorAll(menus)].filter(Boolean) as Element[];
  for (const r of roots) {
    for (const e of r.querySelectorAll("a[href], button, [role=button], [role=menuitem], [role=link]")) {
      if (seen.has(e) || !visible(e)) continue;
      seen.add(e);
      const i = out.length;
      e.setAttribute("data-mcp-c", String(i));
      out.push({
        i,
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute("role") ?? "",
        aria: clean(e.getAttribute("aria-label")),
        text: clean((e as HTMLElement).innerText).slice(0, 120),
        href: e.getAttribute("href") ?? "",
        ck: e.getAttribute("componentkey") ?? "",
        inMenu: !!e.closest(menus),
      });
    }
  }
  return out;
}

/** Runs in the page: stamps the "More" button closest to the control naming the person (Seguir/Convidar <Name>). */
export function stampMoreNear(name: string): boolean {
  document.querySelectorAll("[data-mcp-more]").forEach((e) => e.removeAttribute("data-mcp-more"));
  const key = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const n = key(name);
  const main = document.querySelector("main");
  if (!main || !n) return false;
  const isMore = (e: Element) => /^(mais|more)(\s+(ações|actions))?$/i.test((e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").trim());
  const anchors = [...main.querySelectorAll("a, button")].filter((e) => ` ${key(e.getAttribute("aria-label") ?? "")} `.includes(` ${n} `));
  for (const a of anchors) {
    let box: Element | null = a.parentElement;
    for (let up = 0; up < 6 && box && box !== main; up++, box = box.parentElement) {
      const more = [...box.querySelectorAll("button, [role=button]")].find(isMore);
      if (more) {
        more.setAttribute("data-mcp-more", "1");
        return true;
      }
    }
  }
  return false;
}

export const snapshot = (page: Page) => page.evaluate(snapshotControls).catch(() => [] as PageControl[]);

/** The person's name: document.title ("Name | LinkedIn"), else the first h1/h2 in <main>. */
export async function profileName(page: Page): Promise<string> {
  const fromTitle = nameFromTitle(await page.title().catch(() => ""));
  if (fromTitle && !/^linkedin$/i.test(fromTitle)) return fromTitle;
  const h = await page.locator("main h1, main h2").first().innerText({ timeout: 2000 }).catch(() => "");
  return h.replace(/\s+/g, " ").trim();
}

/** Toast "invitation sent", or (after re-opening the profile) a Pending / "Retirar convite" control. */
async function inviteVerified(page: Page, target: string, name: string, landed: string): Promise<boolean> {
  const toast = await pollUntil(async () => {
    const t = (await page.locator(".artdeco-toast-item, [role=alert], [role=status]").allInnerTexts().catch(() => [] as string[])).join("\n");
    return INVITE_SENT_RE.test(t) ? true : null;
  }, 3000, 500);
  if (toast) return true;
  await closeOverlays(page).catch(() => null);
  await nav(page, target, "profile");
  await page.locator("main").first().waitFor({ timeout: 8000 }).catch(() => null);
  await pause(800, 1400);
  const ok = await pollUntil(async () => (classifyProfile(await snapshot(page), name, landed) === "pending" ? true : null), 4000, 700);
  return !!ok;
}

/**
 * Sends one invitation to the TARGET profile, never through a suggestion card. Checks, in order:
 * - the page is a /in/ profile and is the prepared person (vanity slug, or the cached name for opaque ids);
 * - state from the controls that name the person: Pending / 1st degree -> skipped;
 * - the connect control is the custom-invite link for the landed slug AND its aria-label names the person
 *   (else the person's own "More" menu item);
 * - after the click: an invite modal OR the /preload/custom-invite/ page for the same slug; weekly-limit /
 *   email-required texts stop; the note is typed and read back exactly; Send must be unique;
 * - success only after the "sent" toast or a Pending control on the re-opened profile.
 * Every failure carries `diag`: the labels/hrefs of up to 15 relevant controls, to iterate from live output.
 */
export async function executeConnect(url: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const target = normaliseProfileId(url);
  if (!target) return connectFail("invalid_profile_url");
  const note = opts.note?.trim() || undefined;
  if (note && note.length > NOTE_MAX) return connectFail("note_too_long");
  const slug = profileSlug(target)!;
  const expected = opts.expectedName && !isPlaceholderName(opts.expectedName) ? opts.expectedName : undefined;
  const page = await getPage();
  let sent = false;
  let name = "";
  let landed = slug;
  // Last control about to be clicked: a click that times out reports where it stopped, with the page's controls.
  let step = "open_profile";
  const diag = async () => diagControls(await snapshot(page), name || expected || "");
  const fail = async (reason: string, extra: Partial<ConnectResult> = {}) => {
    const d = await diag().catch(() => "");
    await closeOverlays(page).catch(() => null);
    return connectFail(reason, { name: name || undefined, diag: d || undefined, ...extra });
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
    landed = profileSlug(page.url()) ?? slug;

    let controls = await snapshot(page);
    const state = classifyProfile(controls, name, landed);
    if (state === "pending") return { success: false, status: "skipped", reason: "already_pending", name };
    if (state === "connected") return { success: false, status: "skipped", reason: "already_connected", name };

    // Before our own More menu is opened, a control inside some other open menu/dialog never counts.
    let found = findConnectControl(controls.filter((c) => !c.inMenu), landed, name);
    if ("reason" in found && state === "more") {
      // The person's own "More" menu (the one next to "Seguir <Name>"), never a post's or a suggestion's.
      if (await page.evaluate(stampMoreNear, name).catch(() => false)) {
        step = "more_menu";
        await page.locator("[data-mcp-more]").first().click({ timeout: 5000 });
        await pause(600, 1000);
        controls = await snapshot(page);
        const inMenu = classifyProfile(controls.filter((c) => c.inMenu), name, landed);
        if (inMenu === "pending" || inMenu === "connected") {
          await page.keyboard.press("Escape").catch(() => null);
          return { success: false, status: "skipped", reason: inMenu === "pending" ? "already_pending" : "already_connected", name };
        }
        found = findConnectControl(controls, landed, name);
      }
    }
    if ("reason" in found) return await fail(state === "follow_only" ? `follow_only_no_connect (${found.reason})` : found.reason);

    const btn = page.locator(`[data-mcp-c="${found.i}"]`).first();
    if (!(await btn.count())) return await fail("connect_control_vanished");
    step = "connect_control";
    await btn.click({ timeout: 5000 });
    await pause(900, 1500);
    await afterAction(page);

    // Modal over the profile, or navigation to /preload/custom-invite/?vanityName=<slug> (handled the same way).
    const modal = inviteDialog(page);
    const seen = await pollUntil(async () => {
      if (await modal.count()) return "modal" as const;
      if (/custom-invite/i.test(page.url())) return "page" as const;
      const t = await overlayText(page);
      if (WEEKLY_LIMIT_RE.test(t) || EMAIL_REQUIRED_RE.test(t)) return "modal" as const;
      return null;
    }, 6000, 400);
    if (seen === "page") {
      if (inviteHrefSlug(page.url()) !== landed) return await fail("invite_page_for_another_profile");
      await page.locator("main, [role=dialog], dialog[open]").first().waitFor({ timeout: 6000 }).catch(() => null);
      await pause(600, 1000);
    }
    const scopeText = async () => `${await overlayText(page)}\n${seen === "page" ? await page.locator("main").first().innerText({ timeout: 3000 }).catch(() => "") : ""}`;
    const text = await scopeText();
    if (WEEKLY_LIMIT_RE.test(text)) {
      await closeOverlays(page);
      tripBreaker("connect weekly invitation limit");
      return connectFail("weekly_limit", { name, stop: "RATE_LIMITED: LinkedIn's weekly invitation limit was reached. Automation suspended; call session_resume once the user confirms." });
    }
    if (EMAIL_REQUIRED_RE.test(text)) return await fail("email_required");
    if (!seen) {
      // No modal and no invite page: some builds send at once. Only a verified Pending counts.
      // A click that sends at once cannot carry the approved note: say so instead of a plain done.
      sent = true;
      const without = note ? { note_sent: false, warning: "LinkedIn sent this invite on the first click, WITHOUT the note" } : {};
      return (await inviteVerified(page, target, name, landed))
        ? { success: true, status: "done", name, ...without }
        : { success: false, status: "unverified", reason: "no_invite_dialog_and_no_pending", name, diag: await diag().catch(() => undefined), ...without };
    }

    // The invite UI: the dialog when there is one (also on the invite page), else the invite page's <main>.
    const ui = (await modal.count()) ? modal : page.locator("main").first();
    if (note) {
      const add = ui.getByRole("button", { name: ADD_NOTE_RE }).first();
      if (!(await add.count())) return await fail("note_unavailable"); // never send without the note the user approved
      step = "add_note";
      await add.click({ timeout: 5000 });
      await pause(500, 900);
      if (NOTE_LIMIT_RE.test(await scopeText())) {
        await closeOverlays(page);
        return connectFail("note_limit", { name, stop: "NOTE_LIMIT: the monthly personalised-note quota is used up; the remaining invites were not sent." });
      }
      const ta = ui.locator("textarea").first();
      if (!(await ta.count())) return await fail("note_unavailable");
      step = "note_box";
      await ta.click({ timeout: 3000 });
      await ta.pressSequentially(note, { delay: 12, timeout: 15000 });
      if ((await ta.inputValue({ timeout: 3000 })) !== note) return await fail("note_not_accepted (longer than this account's note limit?)");
    }

    let send = ui.getByRole("button", { name: note ? SEND_RE : SEND_NO_NOTE_RE });
    if (!note && !(await send.count())) send = ui.getByRole("button", { name: SEND_RE });
    if ((await send.count()) !== 1) return await fail((await send.count()) ? "send_ambiguous" : "send_unavailable (extra details required?)");
    if (!(await send.isEnabled({ timeout: 3000 }))) return await fail("send_disabled");
    const stillTarget = seen === "page" ? inviteHrefSlug(page.url()) === landed : profileSlug(page.url()) === landed;
    if (!stillTarget) return await fail("redirected_away_from_profile");
    sent = true; // from here the invite may be out: only done or unverified
    await send.click({ timeout: 5000 });
    await pause(1200, 1800);
    if (WEEKLY_LIMIT_RE.test(await overlayText(page))) {
      await closeOverlays(page);
      tripBreaker("connect weekly invitation limit");
      return { success: false, status: "unverified", reason: "weekly_limit_after_send", name, stop: "RATE_LIMITED: LinkedIn's weekly invitation limit was reached. Automation suspended; call session_resume once the user confirms." };
    }
    return (await inviteVerified(page, target, name, landed))
      ? { success: true, status: "done", name }
      : { success: false, status: "unverified", reason: "pending_state_not_seen", name, diag: await diag().catch(() => undefined) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    if (sent) return { success: false, status: "unverified", reason: `unverified: ${clip(msg, 200)}`, stop: ACCOUNT_LEVEL.test(msg) ? msg : undefined };
    if (ACCOUNT_LEVEL.test(msg)) throw e;
    // Nothing was sent: a plain failure that says which click broke, with the controls seen (fail() closes overlays).
    return await fail(`${step}: ${clip(msg, 160)}`);
  }
}
