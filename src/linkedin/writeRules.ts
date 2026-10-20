/**
 * Pure rules behind the two write flows (Easy Apply submit, connection invite): button labels,
 * page states and URL normalisation. No browser, no db, so they are unit-tested directly.
 * Labels are PT-BR (the dedicated profile's locale) and EN. Every regex is anchored or bounded.
 */

// ---- Easy Apply ----

export const EASY_APPLY_BTN_RE = /candidatura simplificada|easy apply/i;
/** h2 of the Easy Apply dialog ("Candidate-se para X" / "Apply to X"). The post-submit dialog does not match. */
export const APPLY_DIALOG_TITLE_RE = /^(Candidate-se|Candidatar-se|Apply to)/i;
/** Containers the Easy Apply dialog can be (native <dialog> or an ARIA dialog). */
export const EASY_APPLY_DIALOG_SEL = "dialog[open], [role=dialog]";
/** Visible text or aria-label of the "go to the next step" button (never the submit one). */
export const NEXT_RE =
  /^(avançar|avaliar|revisar|revise|continuar|next|review|continue)(\s+(para a próxima etapa|sua candidatura|a sua candidatura|to next step|your application))?$/i;
export const SUBMIT_RE = /^(enviar candidatura|enviar|submit application|submit)$/i;
/** Confirmation shown in the post-submit dialog / toast. */
export const APPLIED_RE = /candidatura (foi )?enviada|candidatura enviada com sucesso|application (was )?sent|application submitted|applied successfully/i;
/** "Salvar esta candidatura?" means the dialog was dismissed, not submitted. */
export const SAVE_PROMPT_RE = /salvar esta candidatura|save this application/i;
/** Banner on a job that no longer takes applications. */
export const CLOSED_RE = /não aceita mais candidaturas|não está mais aceitando candidaturas|no longer accepting applications/i;

export const isClosedJobText = (text: string) => CLOSED_RE.test(text);

/** Wording of a real validation message. `[role=alert]` alone also matches toasts and a11y announcers. */
const ERROR_WORDS =
  /obrigatóri|necessári|inválid|insira|informe|selecione|preencha|digite|corrija|deve ser|required|invalid|please (enter|select|make|provide|fill)|enter a|select an|must be/i;

export type ErrorNode = { alert: boolean; text: string; visible: boolean };

/**
 * Field-level error nodes (inline feedback, *-error ids) count when visible with text;
 * a bare [role=alert] counts only when its text reads like a validation message.
 */
export function pickErrors(nodes: ErrorNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    const t = n.text.replace(/\s+/g, " ").trim();
    if (!n.visible || !t) continue;
    if (n.alert && !ERROR_WORDS.test(t)) continue;
    out.add(t.slice(0, 200));
  }
  return [...out];
}

/** Toast after a submit that did not go through (or may not have). */
export const SUBMIT_ERROR_RE = /não foi possível|nao foi possivel|tente novamente|something went wrong|try again|\berro\b|\berror\b/i;

export type SubmitState = "confirmed" | "rejected" | "pending" | "error";

/**
 * After the submit click, one poll:
 * - confirmed = success text, or the Easy Apply dialog has been gone for >= 2 consecutive polls (~1 s apart)
 *   with no "save this application?" prompt and no error toast (a single closed poll can be a re-render);
 * - rejected = dialog still open with validation errors (nothing was sent);
 * - error = an error toast ("não foi possível", "try again"): outcome unknown, the caller reports unverified;
 * - pending = keep polling.
 * `toastText` is toasts/alerts only (a question in the dialog must not read as an error).
 */
export function submitState(s: { dialogOpen: boolean; overlayText: string; toastText?: string; errors: string[]; closedPolls?: number }): SubmitState {
  const toast = s.toastText ?? "";
  if (APPLIED_RE.test(s.overlayText) || APPLIED_RE.test(toast)) return "confirmed";
  if (s.dialogOpen && s.errors.length) return "rejected";
  if (SUBMIT_ERROR_RE.test(toast)) return "error";
  if (s.dialogOpen) return "pending";
  if (SAVE_PROMPT_RE.test(s.overlayText)) return "pending";
  return (s.closedPolls ?? 0) >= 2 ? "confirmed" : "pending";
}

/** Polls `probe` until it returns a value (not null/undefined) or `ms` passes; null on timeout. */
export async function pollUntil<T>(
  probe: () => Promise<T | null | undefined>,
  ms: number,
  every = 400,
  wait: (ms: number) => Promise<unknown> = (n) => new Promise((r) => setTimeout(r, n)),
): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() >= end) return null;
    await wait(every);
  }
}

/** The browser is on the job being applied to: /jobs/view/<id>/ or a list page with ?currentJobId=<id>. */
export function onJobPage(url: string, jobId: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^([a-z]{2,3}\.|www\.)?linkedin\.com$/i.test(u.hostname)) return false;
  const m = u.pathname.match(/^\/jobs\/view\/(\d+)\/?$/);
  return (m !== null && m[1] === jobId) || u.searchParams.get("currentJobId") === jobId;
}

const COMPANY_NOISE = new Set("ltda sa inc llc ltd grupo group brasil brazil the de da do das dos e and company empresa co corp corporation holding".split(" "));

/**
 * The Easy Apply dialog title ("Candidate-se para Acme", "Candidate-se à empresa Acme", "Apply to Acme") names
 * the job's company. Equal/contained names or one shared significant word count; an unknown company passes.
 */
export function dialogNamesCompany(title: string, company: string | null | undefined): boolean {
  if (!company?.trim()) return true;
  const t = nameKey(title.replace(/^\s*(candidate-se|candidatar-se|apply to)\s+((para|a|à|ao|at)\s+)?((a\s+)?empresa\s+)?/i, ""));
  const c = nameKey(company);
  if (!t || !c) return false;
  if (t === c || t.includes(c) || c.includes(t)) return true;
  const sig = (x: string) => x.split(" ").filter((w) => w.length >= 3 && !COMPANY_NOISE.has(w));
  const tt = new Set(sig(t));
  return sig(c).some((w) => tt.has(w));
}

/** What the job page's top card says (jobs.ts parseJobLines). */
export type JobTop = { title?: string; location?: string; modality?: string; applied?: boolean; closed?: boolean };
export type GateResult = { status: "skipped" | "failed"; reason: string; closed?: boolean; alreadyApplied?: boolean };

/**
 * Checks before the Easy Apply button is touched: still on the target job (no redirect), the job's own top
 * card is not closed / already applied, and the modality/location still fit the user's preferences.
 */
export function applyGate(url: string, jobId: string, top: JobTop, fits?: (t: JobTop) => boolean): GateResult | null {
  if (!onJobPage(url, jobId)) return { status: "failed", reason: "redirected" };
  if (top.closed) return { status: "skipped", reason: "job_closed", closed: true };
  if (top.applied) return { status: "skipped", reason: "already_applied", alreadyApplied: true };
  if (fits && !fits(top)) return { status: "skipped", reason: "modality_mismatch" };
  return null;
}

// ---- connection invite ----

/** LinkedIn's limit for an invitation note. Some accounts get 200: the typed text is read back and compared. */
export const NOTE_MAX = 300;

export const CONNECT_RE = /^(conectar|connect)$|^(convidar|invite)\s.{1,120}\s(para se conectar|to connect)$/i;
export const MORE_RE = /^(mais|more)(\s+(ações|actions))?$/i;
export const PENDING_RE = /^(pendente|pending)\b|retirar convite|withdraw invitation/i;
export const CONNECTED_RE = /^(remover conexão|remove connection)\b/i;
export const FOLLOW_RE = /^(seguir|follow)\b/i;
export const ADD_NOTE_RE = /^(adicionar( uma)? nota|add a note)$/i;
export const SEND_RE = /^(enviar|send)(\s+(convite|invitation))?$/i;
export const SEND_NO_NOTE_RE = /^(enviar sem( uma)? nota|send without a note)$/i;
export const INVITE_MODAL_RE = /adicionar( uma)? nota|add a note|enviar sem( uma)? nota|send without a note|personaliz/i;
export const INVITE_SENT_RE = /convite enviado|convite foi enviado|invitation sent|invitation was sent/i;
export const WEEKLY_LIMIT_RE = /limite semanal|limite de convites|weekly (invitation )?limit|invitation limit/i;
export const NOTE_LIMIT_RE = /(usou|esgotou|atingiu).{0,40}(notas|convites) personalizad|(used|out of|reached).{0,40}personali[sz]ed (notes|invitations)/i;
export const EMAIL_REQUIRED_RE = /(insira|informe|digite) o e-?mail|endereço de e-?mail|enter (their|the|an) email|email address/i;

/** "Convidar Maria Silva para se conectar" / "Invite Maria Silva to connect" -> "Maria Silva". */
export function inviteLabelName(label: string): string | null {
  const m = label.trim().match(/^(?:convidar|invite)\s(.{1,120})\s(?:para se conectar|to connect)$/i);
  return m ? m[1].trim() : null;
}

/** Lowercase, accents and punctuation removed, single spaces. */
export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The found name has the expected first and last names (credentials/emoji around them are ignored). */
export function nameMatches(found: string, expected: string): boolean {
  const f = nameKey(found).split(" ").filter(Boolean);
  const e = nameKey(expected).split(" ").filter((t) => t.length > 1);
  if (!f.length || !e.length) return false;
  const has = (t: string) => f.includes(t);
  return has(e[0]) && (e.length === 1 || has(e[e.length - 1]) || nameKey(found).includes(nameKey(expected)));
}

/**
 * Is the open profile the one prepared? A vanity slug must still be in the URL. An opaque ACo... id redirects
 * to some vanity URL, so the slug proves nothing: it needs the cached name, matched against the page's h1.
 * Returns the failure reason, or null when the page is the target.
 */
export function profileTargetCheck(o: { slug: string; pageUrl: string; h1: string; expected?: string }): string | null {
  const here = profileSlug(o.pageUrl);
  if (!here) return "redirected_away_from_profile";
  const opaque = isOpaqueId(o.slug);
  if (!opaque && here !== o.slug) return "redirected_away_from_profile";
  if (opaque && !o.expected) return "opaque_id_without_known_name (run people_search so the name is cached, or use the vanity URL)";
  if (o.expected && !nameMatches(o.h1, o.expected)) return `name_mismatch: page shows "${o.h1.slice(0, 80)}"`;
  return null;
}

/** Placeholder for out-of-network members: not a real name to verify against. */
export const isPlaceholderName = (n: string) => /^(membro do linkedin|linkedin member)$/i.test(n.trim());

/** Opaque member ids (ACoAA...) are case-sensitive and redirect to the vanity URL. */
export const isOpaqueId = (slug: string) => /^ACo[A-Za-z0-9_-]{10,}$/.test(slug);

/**
 * Accepts https://(www.|xx.)linkedin.com/in/<slug>[/<locale>][/][?...] or a bare slug; returns
 * https://www.linkedin.com/in/<slug>/ (vanity slugs lowercased) or null. people_search emits "/in/<slug>/pt"
 * links: only that trailing locale segment is dropped, any other sub-page is rejected.
 */
export function normaliseProfileId(input: string): string | null {
  const s = input.trim();
  let slug: string | undefined;
  if (/^[\p{L}\p{N}_%-]{2,100}$/u.test(s)) slug = s;
  else {
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol) || !/^([a-z]{2,3}\.|www\.)?linkedin\.com$/i.test(u.hostname)) return null;
    if (u.username || u.password || u.port) return null;
    slug = u.pathname.match(/^\/in\/([^/]+)(?:\/[a-z]{2}(?:_[A-Z]{2})?)?\/?$/)?.[1];
  }
  if (!slug) return null;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  if (!/^[\p{L}\p{N}_-]{2,100}$/u.test(slug)) return null;
  if (!isOpaqueId(slug)) slug = slug.toLowerCase();
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
}

/** Slug of a profile URL (decoded, vanity lowercased), or null when it is not a /in/ page. */
export function profileSlug(url: string): string | null {
  const n = normaliseProfileId(url);
  return n ? decodeURIComponent(n.slice("https://www.linkedin.com/in/".length, -1)) : null;
}

export type TopCardState = "connect" | "pending" | "connected" | "more" | "follow_only" | "none";

/**
 * Profile top card, from its button labels (aria-label and text) and its text. Pending and 1st degree
 * win over a Connect button; with no Connect, "More" may hold it; Follow alone means no invite path.
 */
export function classifyTopCard(labels: string[], text: string): TopCardState {
  const l = labels.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (l.some((x) => PENDING_RE.test(x))) return "pending";
  // degree marker on its own line or after the name separator ("Maria Silva · 1º"), not "1st Line Support" in a headline
  if (/(^|[·•])[ \t]*1(º|°|st)([ \t]+(grau|degree)([ \t]+connection)?)?[ \t]*$/im.test(text) || l.some((x) => CONNECTED_RE.test(x))) return "connected";
  if (l.some((x) => CONNECT_RE.test(x))) return "connect";
  if (l.some((x) => MORE_RE.test(x))) return "more";
  if (l.some((x) => FOLLOW_RE.test(x))) return "follow_only";
  return "none";
}

// ---- profile page (2026 UI: no <h1>, hashed classes; only aria-label / href / componentkey are stable) ----

/** "(3) Maria Silva | LinkedIn" -> "Maria Silva" (notification count and site suffix removed). */
export function nameFromTitle(title: string): string {
  return title
    .replace(/^\s*\(\d+\+?\)\s*/, "")
    .replace(/\s*[|–-]\s*LinkedIn\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One clickable element of the page, as the page snapshot reports it (index = data-mcp-c stamp). */
export type PageControl = { i: number; tag: string; role: string; aria: string; text: string; href: string; ck: string; inMenu: boolean };

/** vanityName of a /preload/custom-invite/?vanityName=<slug> link (decoded, lowercased), else null. */
export function inviteHrefSlug(href: string): string | null {
  if (!/custom-invite/i.test(href)) return null;
  try {
    const v = new URL(href, "https://www.linkedin.com").searchParams.get("vanityName");
    return v ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const labelOf = (c: PageControl) => (c.aria || c.text).replace(/\s+/g, " ").trim();
/** The label names this person ("Seguir Maria Silva", "Convidar Maria Silva para se conectar"). */
export const mentions = (label: string, name: string) => {
  const l = ` ${nameKey(label)} `;
  const n = nameKey(name);
  return !!n && l.includes(` ${n} `);
};

/**
 * The connect control for THIS profile, never a suggestion card's:
 * - a link /preload/custom-invite/?vanityName=<landed slug> whose aria-label "Convidar <Name> para se conectar"
 *   names the page's person (both must agree);
 * - or, inside an opened "More" menu, an item labelled "Convidar <Name> para se conectar" / "Conectar" with no
 *   other person's link.
 * Returns the control, or the reason none qualifies.
 */
export function findConnectControl(controls: PageControl[], landedSlug: string, name: string): PageControl | { reason: string } {
  const slug = landedSlug.toLowerCase();
  const links = controls.filter((c) => inviteHrefSlug(c.href) !== null);
  const mine = links.filter((c) => inviteHrefSlug(c.href) === slug);
  for (const c of mine) {
    const named = inviteLabelName(labelOf(c));
    if (named && nameMatches(named, name)) return c;
  }
  if (mine.length) return { reason: "connect_link_names_someone_else" };
  const menu = controls.filter((c) => c.inMenu && !c.href && CONNECT_RE.test(labelOf(c)));
  for (const c of menu) {
    const named = inviteLabelName(labelOf(c));
    if (!named || nameMatches(named, name)) return c;
  }
  return { reason: links.length ? "only_other_profiles_connect_links" : "no_connect_control" };
}

export type ProfileState = "connect" | "pending" | "connected" | "more" | "follow_only" | "none";

/**
 * Profile state from every control whose label names the person (plus unnamed "Mais"/"More" buttons):
 * Pending / "Retirar convite" -> pending; 1st degree or "Remover conexão" -> connected; their own invite link -> connect;
 * else a "More" menu to try; "Seguir <Name>" alone -> follow_only.
 */
export function classifyProfile(controls: PageControl[], name: string, landedSlug: string): ProfileState {
  const named = controls.filter((c) => mentions(labelOf(c), name));
  if (named.some((c) => /pendente|pending|retirar convite|withdraw invitation/i.test(labelOf(c)))) return "pending";
  if (named.some((c) => /(^|\s)1(º|°|st)(\s|$)/.test(labelOf(c)) || CONNECTED_RE.test(labelOf(c)))) return "connected";
  if (!("reason" in findConnectControl(controls, landedSlug, name))) return "connect";
  if (controls.some((c) => !c.inMenu && MORE_RE.test(labelOf(c)))) return "more";
  if (named.some((c) => FOLLOW_RE.test(labelOf(c)))) return "follow_only";
  return "none";
}

/**
 * Debug line for a failed connect: up to 15 controls that matter (naming the person, invite links, More,
 * Follow, Pending, Send/Note), as `label -> href` clipped. Control labels only, never page text.
 */
export function diagControls(controls: PageControl[], name: string): string {
  const interesting = (c: PageControl) => {
    const l = labelOf(c);
    return mentions(l, name) || inviteHrefSlug(c.href) !== null || c.inMenu || MORE_RE.test(l) || /pendente|pending|enviar|send|nota|note|conectar|connect/i.test(l);
  };
  const pick = controls.filter(interesting).slice(0, 15);
  return pick
    .map((c) => {
      const href = c.href ? ` -> ${c.href.replace(/^https?:\/\/[^/]+/, "").slice(0, 80)}` : "";
      return `[${c.inMenu ? "menu " : ""}${c.role || c.tag}] ${labelOf(c).slice(0, 80)}${href}`;
    })
    .join(" | ")
    .slice(0, 1800);
}

/** Items of the opened "More" menu. */
export function classifyMenu(labels: string[]): "connect" | "pending" | "connected" | "none" {
  const l = labels.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (l.some((x) => PENDING_RE.test(x))) return "pending";
  if (l.some((x) => CONNECTED_RE.test(x))) return "connected";
  if (l.some((x) => CONNECT_RE.test(x))) return "connect";
  return "none";
}
