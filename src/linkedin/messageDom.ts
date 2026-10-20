// In-page functions of message_execute (page.evaluate): no imports at runtime, so a local diagnostic can run them
// against a live page without opening the database. Types only from messageRules.
import type { ComposerSnap, ConvMessage } from "./messageRules.js";

/**
 * Runs in the page. Every visible message composer: a message box (contenteditable / textarea) and its
 * nearest container holding a heading and a Send button. Stamps data-mcp-cmp / data-mcp-box / data-mcp-b
 * (buttons) so the chosen ones can be clicked. Reads labels, headings and text only.
 * The 2026 message overlay renders inside an open shadow root (#interop-outlet): every open shadow root is
 * searched too (Playwright locators pierce open shadow DOM, so the stamps stay clickable).
 */
export function snapshotComposers(): ComposerSnap[] {
  const scopes: (Document | ShadowRoot)[] = [document];
  for (let k = 0; k < scopes.length; k++) for (const e of scopes[k].querySelectorAll("*")) if (e.shadowRoot) scopes.push(e.shadowRoot);
  const all = (sel: string) => scopes.flatMap((s) => [...s.querySelectorAll(sel)]);
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  for (const a of ["data-mcp-box", "data-mcp-cmp", "data-mcp-b"]) all(`[${a}]`).forEach((e) => e.removeAttribute(a));
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => !!((e as HTMLElement).offsetParent || e.getClientRects().length);
  const labelOf = (e: Element) => clean(e.getAttribute("aria-label") || (e as HTMLElement).innerText);
  const isBox = (e: Element) => visible(e) && !e.parentElement?.closest("[contenteditable=true]");
  const valueOf = (e: Element) => (e instanceof HTMLTextAreaElement ? e.value : (e as HTMLElement).innerText) ?? "";
  const BOX = "[contenteditable=true], textarea";
  const HEAD = "h1, h2, h3, h4, [role=heading]";
  const out: ComposerSnap[] = [];
  const roots: Element[] = [];
  for (const box of all(BOX)) {
    if (!isBox(box)) continue;
    let root: Element | null = null;
    for (let e = box.parentElement, up = 0; e && e !== document.body && up < 14; e = e.parentElement, up++) {
      const send = [...e.querySelectorAll("button, [role=button]")].some((b) => visible(b) && /^(enviar|send)$/i.test(labelOf(b)));
      if (send && e.querySelector(HEAD)) {
        root = e;
        break;
      }
    }
    if (!root || roots.includes(root)) continue;
    roots.push(root);
    const i = out.length;
    root.setAttribute("data-mcp-cmp", String(i));
    box.setAttribute("data-mcp-box", String(i));
    const heads = [...root.querySelectorAll(HEAD)].filter(visible).slice(0, 3).map((h) => clean((h as HTMLElement).innerText));
    // A chip and an element nested in it (both match: "...pill" inside "...recipient li") are one recipient:
    // only the innermost matches count, so two real recipients stay two and one never reads as two.
    const chipEls = [...root.querySelectorAll("[class*=pill], [class*=recipient] li")].filter(visible);
    const pills = chipEls
      .filter((p) => !chipEls.some((q) => q !== p && p.contains(q)))
      .map((p) => clean((p as HTMLElement).innerText))
      .filter(Boolean)
      .slice(0, 5);
    const buttons = [...root.querySelectorAll("button, [role=button]")].filter(visible).slice(0, 40).map((b, k) => {
      b.setAttribute("data-mcp-b", `${i}-${k}`);
      return { k, label: labelOf(b).slice(0, 120), disabled: (b as HTMLButtonElement).disabled === true || b.getAttribute("aria-disabled") === "true" };
    });
    const typed = clean(valueOf(box));
    const all = clean((root as HTMLElement).innerText);
    out.push({
      i,
      titles: [clean(root.getAttribute("aria-label")), ...heads].filter(Boolean),
      pills,
      // the box's own text is left out: the user's words must not read as upsell wording
      text: (typed ? all.replace(typed, " ") : all).slice(0, 3000),
      boxText: valueOf(box).slice(0, 4000),
      boxes: [...root.querySelectorAll(BOX)].filter(isBox).length,
      focused: root.contains(active),
      fullPage: location.pathname.startsWith("/messaging") && !!root.closest("main"),
      buttons,
    });
  }
  return out;
}

/**
 * Runs in the page: the messages of composer `i` in order (sender carried over within a group), whether
 * each is the user's own when the page says so, and visible alert/error text.
 */
export function readConversation(i: number): { messages: ConvMessage[]; alert: string } {
  // same open-shadow-root search as snapshotComposers (in-page code can't share helpers)
  const scopes: (Document | ShadowRoot)[] = [document];
  for (let k = 0; k < scopes.length; k++) for (const e of scopes[k].querySelectorAll("*")) if (e.shadowRoot) scopes.push(e.shadowRoot);
  const root = scopes.map((s) => s.querySelector(`[data-mcp-cmp="${i}"]`)).find(Boolean) ?? null;
  if (!root) return { messages: [], alert: "" };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => !!((e as HTMLElement).offsetParent || e.getClientRects().length);
  const messages: ConvMessage[] = [];
  let sender = "";
  for (const li of root.querySelectorAll("li")) {
    if (li.closest("[contenteditable=true]")) continue;
    // The message's own body: one whose nearest <li> is this one. A group <li> holding message <li>s has none, and
    // the 2026 message <li> holds a quick-reaction emoji <ul><li> that must not hide the message itself.
    const body = [...li.querySelectorAll("[class*=listitem__body], [class*=message-body], p")].find((b) => b.closest("li") === li);
    const n = [...li.querySelectorAll("[class*=group__name], [class*=sender-name]")].find((x) => x.closest("li") === li);
    if (n) sender = clean((n as HTMLElement).innerText);
    const text = body ? clean((body as HTMLElement).innerText) : "";
    if (!text) continue;
    // The event item itself (class token exactly "msg-s-event-listitem"), not "msg-s-event-listitem--group-a11y-heading".
    const ev = li.querySelector('[class~="msg-s-event-listitem"]') ?? li.querySelector("[class*=event-listitem]:not([class*=a11y])") ?? li;
    const cls = typeof ev.className === "string" ? ev.className : "";
    let own: boolean | null = /event-listitem/.test(cls) ? !/--other\b/.test(cls) : null;
    const a11y = clean(li.querySelector("[class*=visually-hidden], [class*=a11y]")?.textContent);
    if (/^(você|you)\b.{0,40}(enviou|sent)/i.test(a11y)) own = true;
    messages.push({ own, sender: sender.slice(0, 120), text: text.slice(0, 4000) });
  }
  const alert = [...root.querySelectorAll("[role=alert], [class*=error], [class*=failed]")]
    .filter(visible)
    .map((e) => clean((e as HTMLElement).innerText))
    .join(" ")
    .slice(0, 500);
  return { messages: messages.slice(-30), alert };
}
