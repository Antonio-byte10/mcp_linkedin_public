import type { Page } from "playwright-core";
import { getPage, hasTime } from "../browser/session.js";
import { afterAction, nav } from "../browser/nav.js";
import { ACCOUNT_LEVEL } from "../guard/ledger.js";
import { onlyNew } from "../store/watch.js";
import { getJob, recordEnrichFailure, saveDetail, setClosed, setSearchKeywords, upsertJob } from "../store/db.js";

export type JobSearchParams = {
  keywords: string;
  location?: string;
  remote?: "onsite" | "hybrid" | "remote";
  easy_apply?: boolean;
  posted_within?: "day" | "week" | "month";
  experience?: ("internship" | "entry" | "associate" | "senior" | "director" | "executive")[];
  limit?: number;
  /** Result position to start from (0-based). Pass the previous call's `next_start` to continue. */
  offset?: number;
};

const WT = { onsite: "1", remote: "2", hybrid: "3" } as const;
const TPR = { day: "r86400", week: "r604800", month: "r2592000" } as const;
const EXP = { internship: "1", entry: "2", associate: "3", senior: "4", director: "5", executive: "6" } as const;

export function buildSearchUrl(p: JobSearchParams, start = 0): string {
  const q = new URLSearchParams({ keywords: p.keywords });
  if (p.location) q.set("location", p.location);
  if (p.remote) q.set("f_WT", WT[p.remote]);
  if (p.easy_apply) q.set("f_AL", "true");
  if (p.posted_within) q.set("f_TPR", TPR[p.posted_within]);
  if (p.experience?.length) q.set("f_E", p.experience.map((e) => EXP[e]).join(","));
  if (start) q.set("start", String(start));
  return `https://www.linkedin.com/jobs/search/?${q}`;
}

/** A whole status line, never a title/company containing the word ("Applied Materials", "Applied Scientist"). */
export const APPLIED_LINE = /^(Candidatou-se|Candidatura enviada|Applied)(\s+(há\s.*|on\s.*|em\s.*|\d+\s*\S*\s*(ago)?))?$/i;

/** Relative publish date: "há 2 dias", "Republicado há 2 dias", "Anunciada há 3 d", "Reposted 2 days ago". */
export const POSTED_RE = /\bhá\s+\d|\bago$/i;
const APPLICANTS_RE = /\d[\d.,+]*\s+(candidaturas?|applicants?)|\b(candidaturas?|applicants?)\b.*\d/i;

type RawCard = {
  id: string;
  title: string;
  company: string;
  location: string;
  easy_apply: boolean;
  applied: boolean;
  posted: string;
};

const PAGE = 25; // results per LinkedIn search page

/**
 * Legacy Ember list: li[data-occludable-job-id], empty until scrolled into view.
 * Each card is read right after scrolling to it (cards far out of view may be emptied again): the text is
 * awaited up to ~1 s before the card is given up on.
 * Observed line order: title, company, location (modality), insights..., "Candidatura simplificada".
 */
async function readCards(page: Page): Promise<RawCard[]> {
  return page.evaluate(async ({ appliedSrc, postedSrc }: { appliedSrc: string; postedSrc: string }) => {
    const applied = new RegExp(appliedSrc, "i");
    const postedLine = new RegExp(postedSrc, "i");
    const out: RawCard[] = [];
    for (const n of document.querySelectorAll<HTMLElement>("li[data-occludable-job-id]")) {
      n.scrollIntoView({ block: "center" });
      let lines: string[] = [];
      for (let t = 0; t < 4; t++) {
        await new Promise((r) => setTimeout(r, 250));
        lines = n.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
        if (lines.length > 1) break; // lazily hydrated cards render the title first, the rest a moment later
      }
      const id = n.getAttribute("data-occludable-job-id") ?? "";
      if (!id || !lines.length) continue;
      const text = (sel: string) => n.querySelector<HTMLElement>(sel)?.innerText.trim() ?? "";
      out.push({
        id,
        title: text("a.job-card-list__title, a.job-card-container__link strong, a[href*='/jobs/view/'] strong") || lines[0],
        company: text(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description") || lines[1] || "",
        location: text(".artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper") || lines[2] || "",
        // Footer line can carry extra text ("Promovida · Candidatura simplificada"); skip the title line.
        easy_apply: lines.slice(1).some((l) => /candidatura simplificada|easy apply/i.test(l)),
        applied: lines.slice(2).some((l) => applied.test(l)),
        // <time> when the card has one, else its "há 2 dias" / "2 days ago" line
        // first line only: <time> can also hold "Nas últimas 24 horas" under "Há 16 horas"
        posted: text("time").split("\n")[0].trim() || lines.slice(1).find((l) => postedLine.test(l) && !applied.test(l) && l.length <= 60) || "",
      });
    }
    return out;
  }, { appliedSrc: APPLIED_LINE.source, postedSrc: POSTED_RE.source });
}

/**
 * Pure paging arithmetic. `cards` are all cards read, in order, starting at the search page that contains `offset`
 * (page-aligned), so the first `offset % 25` are dropped. `next_start` is where the following call should continue
 * (null when LinkedIn has no more results).
 */
export function sliceSearchResults<T>(cards: T[], offset: number, limit: number, exhausted: boolean, pagesRead: number) {
  const pageStart = Math.floor(offset / PAGE) * PAGE;
  const list = cards.slice(offset - pageStart);
  const jobs = list.slice(0, limit);
  let next_start: number | null;
  if (list.length > limit) next_start = offset + limit; // stopped mid-page
  else if (exhausted) next_start = null;
  else next_start = pageStart + pagesRead * PAGE;
  return { jobs, next_start };
}

export async function searchJobs(p: JobSearchParams) {
  const page = await getPage();
  const limit = p.limit ?? 25;
  const offset = Math.max(0, Math.floor(p.offset ?? 0));
  const pageStart = Math.floor(offset / PAGE) * PAGE;
  const seen = new Map<string, RawCard>();
  let partial = false;
  let exhausted = false;
  let pagesRead = 0;
  for (let start = pageStart; seen.size - (offset - pageStart) < limit && start < 1000; start += PAGE) {
    if (pagesRead > 0 && !hasTime(10000)) {
      partial = true;
      break;
    }
    await nav(page, buildSearchUrl(p, start), "search");
    await page.waitForSelector("li[data-occludable-job-id]", { timeout: 8000 }).catch(() => null);
    await afterAction(page);
    const before = seen.size;
    (await readCards(page)).forEach((c) => seen.set(c.id, c));
    pagesRead++;
    if (seen.size === before) {
      exhausted = true; // no new cards: past the last result
      break;
    }
  }
  const { jobs: picked, next_start } = sliceSearchResults([...seen.values()], offset, limit, exhausted, pagesRead);
  // Snapshot before the upserts below: "new" means not cached before this search ran (jobs_watch_run).
  const knownBefore = new Set(picked.filter((c) => getJob(c.id)).map((c) => c.id));
  const jobs = picked.map((c) => {
    const url = `https://www.linkedin.com/jobs/view/${c.id}/`;
    upsertJob({
      id: c.id, title: c.title || null, company: c.company || null, location: c.location || null, url,
      // Card footers render late: trust the f_AL filter, else only a positive sighting; otherwise unknown until jobs_enrich.
      easy_apply: p.easy_apply || c.easy_apply ? 1 : null, posted: c.posted || null, applied: c.applied ? 1 : 0,
    });
    setSearchKeywords(c.id, p.keywords);
    const known = getJob(c.id);
    return { ...c, easy_apply: known?.easy_apply === 1 ? true : known?.easy_apply === 0 ? false : null, applied: c.applied || known?.applied === 1, url };
  });
  return {
    jobs,
    new_ids: onlyNew(jobs, knownBefore).map((j) => j.id),
    partial,
    next_start,
    note: next_start !== null && (partial || jobs.length >= limit) ? `More results: call again with offset=${next_start}.` : undefined,
  };
}

const MODALITY = /^(Remoto|Híbrido|Presencial|Remote|Hybrid|On-site)$/;
const EMPLOYMENT = /^(Tempo integral|Meio período|Contrato|Temporário|Estágio|Voluntário|Full-time|Part-time|Contract|Temporary|Internship|Volunteer)$/;
/** Badge lines that can sit between company/title and the meta line and shift positional parsing. */
const BADGE = /^(Promovida|Promoted|Verificad[ao]|Verified|Reativada|Reposted|Em destaque|Ativamente|Actively|Resposta gerenciada|Responses managed)\b/i;

export type JobAnchors = { company?: string; title?: string };

/**
 * Pure parse of the job view's main lines (see getJobDetail for the observed layout).
 * company/title are taken from the page's own links when they match a line of the top card (anchors),
 * else positionally from the lines before the meta line, skipping badge lines.
 * `hasMeta` is false when no "Location · há 18 horas · 59 candidaturas" line exists (blank / not hydrated page).
 */
export function parseJobLines(L: string[], anchors: JobAnchors = {}) {
  const topCard = L.slice(0, 30);
  const parts = (l: string) => l.split("·").map((s) => s.trim());
  const metaIdx = topCard.findIndex((l) => l.includes("·") && parts(l).some((m) => POSTED_RE.test(m) || APPLICANTS_RE.test(m)));
  const meta = metaIdx >= 0 ? parts(L[metaIdx]) : [];
  const before: string[] = [];
  for (let i = metaIdx - 1; i >= 0 && before.length < 2; i--) if (!BADGE.test(L[i])) before.push(L[i]);
  const anchored = (a: string | undefined) => (a && a.length <= 200 && topCard.includes(a.trim()) ? a.trim() : "");
  const reqIdx = L.findIndex((l) => /^Requisitos adicionados|^Requirements added/i.test(l));
  const requirements: string[] = [];
  if (reqIdx >= 0) for (let i = reqIdx + 1; i < L.length && /^•/.test(L[i]); i++) requirements.push(L[i].replace(/^•\s*/, ""));
  // Status lines live in the top card, before "Sobre a vaga"; the description can't spoof them.
  const aboutIdx = L.findIndex((l) => /^(Sobre a vaga|About the job)$/.test(l));
  const top = L.slice(0, aboutIdx > 0 ? aboutIdx : 15);
  return {
    hasMeta: metaIdx >= 0,
    company: anchored(anchors.company) || before[1] || "",
    title: anchored(anchors.title) || before[0] || "",
    location: meta[0] && !POSTED_RE.test(meta[0]) && !APPLICANTS_RE.test(meta[0]) ? meta[0] : "",
    posted: meta.find((m) => POSTED_RE.test(m)) ?? "",
    applicants: meta.find((m) => APPLICANTS_RE.test(m)) ?? "",
    modality: top.find((l) => MODALITY.test(l)) ?? "",
    employment_type: top.find((l) => EMPLOYMENT.test(l)) ?? "",
    applied: top.some((l) => APPLIED_LINE.test(l)),
    closed: top.some((l) => /não aceita mais candidaturas|no longer accepting/i.test(l)),
    requirements,
  };
}

/**
 * Job view (2026 UI, no <h1>). Observed main lines:
 * company, title, "Location · há 18 horas · 59 candidaturas", modality, employment type,
 * "Candidatura simplificada" | "Candidatar-se", ..., "Sobre a vaga", description...,
 * "Requisitos adicionados pelo anunciante da vaga", "• ...", "Sobre a empresa", company, followers...
 * A blank / not hydrated / 404 page throws JOB_PAGE_EMPTY and writes nothing (no enriched_at stamp, no easy_apply=0);
 * the failure is counted so auto-enrich gives up after MAX_ENRICH_ATTEMPTS.
 */
export async function getJobDetail(id: string) {
  try {
    return await readJobDetail(id);
  } catch (e) {
    // account-level stops (checkpoint, budget, busy profile...) are not this job's fault: never counted
    if (!ACCOUNT_LEVEL.test((e as Error).message)) recordEnrichFailure(id);
    throw e;
  }
}

async function readJobDetail(id: string) {
  const page = await getPage();
  await nav(page, `https://www.linkedin.com/jobs/view/${id}/`, "job");
  await page.waitForSelector("[data-testid=expandable-text-box]", { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(1500);
  await afterAction(page);
  const d = await page.evaluate(() => {
    const main = (document.querySelector("main") ?? document.body) as HTMLElement;
    const lines = main.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    const desc = (document.querySelector("[data-testid=expandable-text-box]") as HTMLElement | null)?.innerText.trim() ?? "";
    const easy = !!document.querySelector("button[aria-label*='candidatura simplificada' i], button[aria-label*='Easy Apply' i]");
    const companyEl = [...main.querySelectorAll<HTMLAnchorElement>("a[href*='/company/']")].find((a) => a.innerText.trim());
    const companyLink = (main.querySelector("a[href*='/company/']") as HTMLAnchorElement | null)?.href.split("?")[0] ?? "";
    const ext = document.querySelector<HTMLAnchorElement>("main a[aria-label*='site da empresa' i], main a[aria-label*='company website' i]")?.href ?? "";
    // Plain (non-Easy) apply button: the apply goes to the company site.
    const extBtn = [...main.querySelectorAll<HTMLElement>("button, a")].some((el) => /^(Candidatar-se|Apply)$/i.test(el.innerText.trim()));
    return { lines, desc, easy, companyLink, ext, extBtn, companyText: companyEl?.innerText.trim() ?? "" };
  });
  // External apply goes through linkedin.com/safety/go/?url=<real ATS url>
  let applyUrl = "";
  if (d.ext) {
    try {
      const u = new URL(d.ext);
      applyUrl = u.pathname.startsWith("/safety/go") ? u.searchParams.get("url") ?? d.ext : d.ext;
    } catch {
      applyUrl = d.ext;
    }
  }
  const parsed = parseJobLines(d.lines, { company: d.companyText });
  if (!d.desc && !parsed.hasMeta && !parsed.closed) {
    throw new Error(`JOB_PAGE_EMPTY: job ${id} rendered no description or header (not hydrated, blocked, removed or 404); nothing was saved.`);
  }
  const external = !d.easy && !!(applyUrl || d.extBtn);
  const detail = {
    id,
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    company: parsed.company,
    company_url: d.companyLink.replace(/\/(life|about|jobs|posts)\/?$/, ""),
    title: parsed.title,
    location: parsed.location,
    posted: parsed.posted,
    applicants: parsed.applicants,
    modality: parsed.modality,
    employment_type: parsed.employment_type,
    easy_apply: d.easy,
    apply_type: d.easy ? "easy_apply" : external ? "external" : "unknown",
    apply_url: d.easy ? "" : applyUrl,
    applied: parsed.applied,
    closed: parsed.closed,
    requirements: parsed.requirements,
    description: d.desc,
  };
  upsertJob({
    id, title: detail.title || null, company: detail.company || null, location: detail.location || null, url: detail.url,
    // 0 ("external") only when an external apply control was really seen; a missing button proves nothing.
    easy_apply: detail.easy_apply ? 1 : external ? 0 : null,
    posted: detail.posted || null, description: detail.description || null,
    applied: detail.applied ? 1 : 0, closed: detail.closed ? 1 : 0, apply_url: detail.apply_url || null,
  });
  // A page that clearly offers an apply button is open, even if the job was flagged closed earlier (reopened / reposted).
  if (!detail.closed && (detail.easy_apply || external)) setClosed(id, false);
  saveDetail(id, detail);
  return detail;
}
