/**
 * Pure rules behind message_prepare / message_execute (1st-degree messages). No browser, no db, so the
 * control selection, recipient checks and text gating are unit-tested directly.
 * NOT yet validated against the live 2026 messaging UI: every rule fails closed (no pick -> nothing typed).
 * Labels are PT-BR and EN. Every regex is anchored or bounded.
 */
import { createHash } from "node:crypto";
import { clip } from "../guard/untrusted.js";
import { MORE_RE, findConnectControl, labelOf, mentions, nameKey, nameMatches, profileSlug, type PageControl } from "./writeRules.js";

/** Longest text message_prepare accepts. */
export const MESSAGE_MAX = 1500;

/** "Enviar mensagem para Maria Silva" / "Message Maria Silva" / "Mensagem"; InMail variants are matched so they can be refused. */
export const MESSAGE_RE = /^(enviar mensagem|mensagem|send message|message|enviar inmail|send inmail|inmail)((\s+(para|a|to))?\s+(.{1,120}))?$/i;
/** Premium / InMail / credits upsell wording (control labels and composer text). Never spent. */
export const INMAIL_RE = /\binmail\b|\bpremium\b|sales navigator|\bcr[ée]ditos?\b|\bcredits?\b/i;
const UPSELL_HREF_RE = /\/premium|\/sales\/|upsell|inmail/i;
export const SEND_MSG_RE = /^(enviar|send)$/i;
// "Fechar sua conversa com X", and the 2026 new-message bubble's "Fechar rascunho da conversa" / "Close your draft conversation"
const CLOSE_CONV_RE = /^(fechar|close)\s+((sua|your)\s+)?(rascunho\s+d[ae]\s+|draft\s+)?(conversa|conversation)\b/i;
const CLOSE_RE = /^(fechar|close|dismiss)$/i;
export const DISCARD_RE = /^(descartar|discard)$/i;
/** Composer box placeholder, in case it is rendered as the box's own text. */
const PLACEHOLDER_RE = /^(escreva uma mensagem|write a message)(\.{3}|…)?$/i;
/** Delivery failure shown on the sent bubble or an alert. */
export const SEND_FAILED_RE = /não foi possível enviar|nao foi possivel enviar|não enviad[ao]|falha ao enviar|not (sent|delivered)|failed to send|couldn.t send|tentar novamente|try again|\bretry\b/i;

// ---- text ----

const INVIS = /[­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ﻿]/g;

/** NFC, invisible characters removed, every whitespace run (newlines, nbsp) one space, trimmed. */
export function normaliseMessageText(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFC").replace(INVIS, "").replace(/\s+/g, " ").trim();
}

/** Equal after whitespace normalisation (case and punctuation count). An empty text never matches. */
export function sameMessageText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseMessageText(a);
  return !!x && x === normaliseMessageText(b);
}

/** The text message_prepare stores: invisible/control characters stripped, CRLF -> LF, trimmed, 1..MESSAGE_MAX. */
export function cleanMessageInput(text: string): string {
  const t = clip(text, 100000).replace(/\r\n?/g, "\n").trim();
  if (!t) throw new Error("text is empty.");
  if (t.length > MESSAGE_MAX) throw new Error(`text is ${t.length} chars (max ${MESSAGE_MAX}).`);
  return t;
}

export const textHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * message_execute gating: the only text ever typed is the one stored in the batch at message_prepare,
 * and only while its SHA-256 still matches (a batch row edited since prepare is refused, nothing burnt).
 */
export function messageTextPlan(meta: Record<string, unknown> | undefined): string {
  const text = meta?.text;
  const hash = meta?.text_sha256;
  if (typeof text !== "string" || !text.trim() || typeof hash !== "string") throw new Error("This batch holds no prepared message text. Run message_prepare again.");
  if (textHash(text) !== hash) throw new Error("The batch text failed its integrity check (SHA-256 mismatch); nothing was sent. Run message_prepare again.");
  if (text.length > MESSAGE_MAX) throw new Error(`The batch text is over ${MESSAGE_MAX} chars. Run message_prepare again.`);
  return text;
}

// ---- profile page ----

/** Cached people.degree says 1st ("1º", "• 1st"). */
export const isFirstDegreeLabel = (degree: string | null | undefined) => /^[•·]?\s*1(º|°|st)(?![\p{L}\p{N}])/iu.test((degree ?? "").trim());

/** Name in "Enviar mensagem para Maria Silva" / "Message Maria Silva", else null (bare "Mensagem"). */
export function messageLabelName(label: string): string | null {
  const m = label.replace(/\s+/g, " ").trim().match(MESSAGE_RE);
  return m?.[5]?.trim() || null;
}

const hrefProfileSlug = (href: string) => {
  const m = href.match(/\/in\/([^/?#]+)/);
  return m ? profileSlug(`https://www.linkedin.com/in/${m[1]}/`) : null;
};

/**
 * The message control for THIS profile, never a suggestion card's or an upsell:
 * - message-like controls (label "Enviar mensagem para <Name>" / "Mensagem", or a /messaging/compose link) outside menus;
 * - one naming someone else, or linking another /in/ slug, is never taken;
 * - any InMail / Premium / credits control for this person (or unnamed) -> inmail_refused (nothing clicked);
 * - one naming this person wins; a bare "Mensagem" when it is the page's only message control, or (2026 profile UI:
 *   own control unnamed, suggestion cards name their people) the only unnamed one, opening a new compose or no link.
 */
export function findMessageControl(controls: PageControl[], name: string, landedSlug: string): PageControl | { reason: string } {
  const slug = landedSlug.toLowerCase();
  const mine: PageControl[] = [];
  const unnamed: PageControl[] = [];
  const others: PageControl[] = [];
  for (const c of controls) {
    if (c.inMenu) continue;
    const label = labelOf(c);
    if (!MESSAGE_RE.test(label) && !/\/messaging\/compose/i.test(c.href)) continue;
    const named = messageLabelName(label);
    const hs = hrefProfileSlug(c.href);
    if ((named && !nameMatches(named, name)) || (hs && hs.toLowerCase() !== slug)) others.push(c);
    else if (named) mine.push(c);
    else unnamed.push(c);
  }
  const upsell = (c: PageControl) => INMAIL_RE.test(labelOf(c)) || UPSELL_HREF_RE.test(c.href);
  if ([...mine, ...unnamed].some(upsell)) return { reason: "inmail_refused" };
  if (mine.length) return mine[0];
  const composeOrNoLink = (c: PageControl) => !c.href || /^(https?:\/\/[^/]+)?\/messaging\/compose/i.test(c.href);
  // The top card and the sticky header repeat the same compose link: one recipient (profileUrn) = one control.
  const urn = (c: PageControl, k: number) => (composeOrNoLink(c) && c.href.match(/[?&]profileUrn=([^&#]+)/)?.[1]) || `#${k}`;
  if (new Set(unnamed.map(urn)).size === 1 && (!others.length || composeOrNoLink(unnamed[0]))) return unnamed[0];
  if (unnamed.length) return { reason: "message_control_ambiguous" };
  return { reason: others.length ? "only_other_profiles_message_controls" : "no_message_control" };
}

const LABEL_FIRST_RE = /(^|[\s·•])1(º|°|st)(\s|$)/i;
const LABEL_OTHER_RE = /(^|[\s·•])(2|3)(º|°|nd|rd)\+?(\s|$)/i;
const LINE_DEGREE_RE = /^[·•]?\s*([123])(º|°|st|nd|rd)\+?(\s+(grau|degree)(\s+connection)?)?$/i;
const LINE_SUFFIX_RE = /[·•]\s*([123])(º|°|st|nd|rd)\+?\s*$/i;

/**
 * Is the open profile a 1st-degree connection? From the controls naming the person (degree marker,
 * "Remover conexão") and the top-card lines right after the name line ("· 1º"). Pending, an invite link
 * for this person or a 2nd/3rd marker -> not_1st. Nothing conclusive -> unknown (callers treat it as not_1st).
 */
export function degreeOnPage(controls: PageControl[], topLines: string[], name: string, landedSlug: string): "1st" | "not_1st" | "unknown" {
  const named = controls.filter((c) => mentions(labelOf(c), name));
  if (named.some((c) => /pendente|pending|retirar convite|withdraw invitation/i.test(labelOf(c)))) return "not_1st";
  if (!("reason" in findConnectControl(controls, landedSlug, name))) return "not_1st";
  let first = named.some((c) => LABEL_FIRST_RE.test(labelOf(c)) || /^(remover conexão|remove connection)\b/i.test(labelOf(c)));
  let other = named.some((c) => LABEL_OTHER_RE.test(labelOf(c)));
  const words = nameKey(name).split(" ").length;
  const idx = topLines.findIndex((l) => nameMatches(l, name) && nameKey(l).split(" ").length <= words + 4);
  if (idx >= 0) {
    const marks = [topLines[idx].match(LINE_SUFFIX_RE)?.[1], ...topLines.slice(idx + 1, idx + 4).map((l) => l.trim().match(LINE_DEGREE_RE)?.[1])];
    const d = marks.find(Boolean);
    if (d === "1") first = true;
    else if (d) other = true;
  }
  if (other) return "not_1st";
  return first ? "1st" : "unknown";
}

/**
 * Debug line for a failed message: up to 15 controls that matter (naming the person, message-like,
 * upsell-like, messaging links, More), as `label -> href`. Control labels only, never page text.
 */
export function diagMessageControls(controls: PageControl[], name: string): string {
  const interesting = (c: PageControl) => {
    const l = labelOf(c);
    return mentions(l, name) || MESSAGE_RE.test(l) || INMAIL_RE.test(l) || /\/messaging|\/premium/i.test(c.href) || MORE_RE.test(l);
  };
  return controls
    .filter(interesting)
    .slice(0, 15)
    .map((c) => `[${c.inMenu ? "menu " : ""}${c.role || c.tag}] ${labelOf(c).slice(0, 80)}${c.href ? ` -> ${c.href.replace(/^https?:\/\/[^/]+/, "").slice(0, 80)}` : ""}`)
    .join(" | ")
    .slice(0, 1800);
}

// ---- composer ----

/**
 * Runs in the page. State of the 2026 message overlay app, which renders inside #interop-outlet's open shadow root:
 * "none" = no outlet on this page (a message link then navigates normally); "loading" = the outlet is only an empty
 * shell (~6 nodes for the first 2-3 s after load): a click on a message link is swallowed and no composer ever
 * opens (seen live); "ready" = the app mounted its messaging dock ("Abrir o menu suspenso de mensagens").
 */
export function messagingOverlayState(): "none" | "loading" | "ready" {
  const host = document.querySelector("#interop-outlet");
  if (!host) return "none";
  const sr = host.shadowRoot;
  if (!sr) return "loading";
  const dock = [...sr.querySelectorAll("[aria-label]")].some((e) => /mensage(m|ns)|messag(e|es|ing)/i.test(e.getAttribute("aria-label") ?? ""));
  return dock ? "ready" : "loading";
}

/** One open message composer (overlay bubble or the /messaging page), as the in-page snapshot reports it. */
export type ComposerSnap = {
  i: number;
  /** Container aria-label and its first headings (the conversation header). */
  titles: string[];
  /** Recipient chips of a new-message composer. */
  pills: string[];
  /** Container text (clipped), for upsell wording. */
  text: string;
  boxText: string;
  /** Message boxes inside the container (must be exactly 1). */
  boxes: number;
  /** Focus is inside (the composer the click just opened). */
  focused: boolean;
  fullPage: boolean;
  buttons: { k: number; label: string; disabled: boolean }[];
};

/**
 * A composer header / chip names exactly this person: equal names, or the name plus up to two extra words
 * (credentials, pronouns like "(Ela/Dela)"). Several participants ("A, B" / "A e B") never count.
 */
export function titleIsPerson(title: string, name: string): boolean {
  const t = nameKey(title);
  const n = nameKey(name);
  if (!t || !n) return false;
  if (t === n) return true;
  if (/[,;&+]|\s(e|and)\s/i.test(title.replace(name, ""))) return false;
  return nameMatches(title, name) && t.split(" ").length <= n.split(" ").length + 2;
}

const namesPerson = (s: ComposerSnap, name: string) => s.titles.some((t) => titleIsPerson(t, name)) || s.pills.some((p) => titleIsPerson(p, name));

/**
 * The composer addressed to THIS person: named in its header/chip (the focused one first, when the click
 * focused one), exactly one message box, at most one recipient chip and it is the person, and no
 * InMail / Premium / credits wording anywhere in it (upsell:false skips that check, for the re-read after
 * sending, when the conversation holds the user's own words). Upsell wording in the conversation history
 * also refuses: a false positive only means nothing is sent.
 */
export function pickComposer(snaps: ComposerSnap[], name: string, o: { upsell?: boolean } = {}): ComposerSnap | { reason: string } {
  const upsell = o.upsell !== false;
  const named = snaps.filter((s) => namesPerson(s, name));
  const focused = named.filter((s) => s.focused);
  const pool = focused.length ? focused : named;
  if (!pool.length) return { reason: upsell && snaps.some((s) => INMAIL_RE.test(s.text)) ? "inmail_refused" : snaps.length ? "recipient_mismatch" : "composer_not_found" };
  if (pool.length > 1) return { reason: "composer_ambiguous" };
  const s = pool[0];
  if (s.boxes !== 1) return { reason: "composer_ambiguous" };
  if (s.pills.length > 1) return { reason: "multiple_recipients" };
  if (s.pills.length === 1 && !titleIsPerson(s.pills[0], name)) return { reason: "recipient_mismatch" };
  if (upsell && (INMAIL_RE.test(s.text) || s.titles.some((t) => INMAIL_RE.test(t)))) return { reason: "inmail_refused" };
  return s;
}

/** Which composer to close after a failure: the one naming the person, else the single focused one (named=false). */
export function composerToClose(snaps: ComposerSnap[], name: string): { s: ComposerSnap; named: boolean } | null | "ambiguous" {
  const named = snaps.filter((s) => namesPerson(s, name));
  if (named.length === 1) return { s: named[0], named: true };
  if (named.length > 1) return "ambiguous";
  const focused = snaps.filter((s) => s.focused);
  return focused.length === 1 ? { s: focused[0], named: false } : null;
}

/**
 * One step of closeComposer, after composerToClose: "closed", "not_closed" (the caller stops the batch) or
 * "act" (clear/close `pick` and look again). With `clear` (text was typed) "closed" needs proof: the
 * composer naming the person was seen during this close and is now gone. A typed composer that cannot be
 * identified, or a focused fallback still open after its one attempt, is not_closed (never cleared: it may
 * be someone else's). Once the named one is gone, other conversations are never touched.
 */
export function closeDecision(
  pick: ReturnType<typeof composerToClose>,
  st: { clear: boolean; namedSeen: boolean; fallbackTried: boolean },
): "closed" | "not_closed" | "act" {
  if (pick === "ambiguous") return "not_closed";
  if (!pick) return !st.clear || st.namedSeen ? "closed" : "not_closed";
  if (!pick.named && st.namedSeen) return "closed";
  if (!pick.named && st.fallbackTried) return st.clear ? "not_closed" : "closed";
  return "act";
}

export const isEmptyBox = (t: string | null | undefined) => {
  const n = normaliseMessageText(t);
  return !n || PLACEHOLDER_RE.test(n);
};

/** The composer's single Send button, or null when there is none or several. */
export function sendButton(s: ComposerSnap) {
  const m = s.buttons.filter((b) => SEND_MSG_RE.test(b.label));
  return m.length === 1 ? m[0] : null;
}

/** "Fechar sua conversa com <Name>" first, else a bare Fechar/Close/Dismiss. Never Minimise. */
export function closeButton(s: ComposerSnap) {
  return s.buttons.find((b) => CLOSE_CONV_RE.test(b.label)) ?? s.buttons.find((b) => CLOSE_RE.test(b.label)) ?? null;
}

export function diagComposers(snaps: ComposerSnap[]): string {
  return (
    `composers=${snaps.length}` +
    snaps
      .slice(0, 4)
      .map((s) => ` [${s.i}] titles=${s.titles.map((t) => t.slice(0, 60)).join("/")} pills=${s.pills.length} boxes=${s.boxes}${s.focused ? " focused" : ""}${s.fullPage ? " page" : ""}`)
      .join(";")
  ).slice(0, 600);
}

// ---- verification ----

/** One message of the conversation. `own` from the page when it says so; null = unknown (decided by sender). */
export type ConvMessage = { own: boolean | null; sender: string; text: string };

/** In a 1:1 conversation, a message whose sender is not the recipient is the user's own. */
export function isOwn(m: ConvMessage, recipient: string): boolean | null {
  if (m.own !== null) return m.own;
  return m.sender.trim() ? !nameMatches(m.sender, recipient) : null;
}

/**
 * Sent and visible: the last own message after the send equals the text, and it is a new one (more own
 * messages than before, or the same text was not among the own messages before). Otherwise unverified.
 * `boxAfter` (the composer re-read after Send) must be empty: LinkedIn clears it on a real send, so text still
 * in it means the send did not go out even when an old identical message is the last one visible.
 */
export function sendVerified(before: ConvMessage[], after: ConvMessage[], text: string, recipient: string, boxAfter?: string | null): boolean {
  if (boxAfter !== undefined && !isEmptyBox(boxAfter)) return false;
  const own = (l: ConvMessage[]) => l.filter((m) => isOwn(m, recipient) === true);
  const a = own(after);
  const b = own(before);
  if (!a.length || !sameMessageText(a[a.length - 1].text, text)) return false;
  return a.length > b.length || !b.some((m) => sameMessageText(m.text, text));
}
