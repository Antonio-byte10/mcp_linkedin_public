import { getPage, hasTime } from "../browser/session.js";
import { afterAction, nav } from "../browser/nav.js";
import { db } from "../store/db.js";
import { cardsByLink, mainLines, pairs } from "./dom.js";
import { COMPANY_NOT_FOUND, extractCompanyId, pickCompany } from "./peoplePure.js";

// Numeric LinkedIn company id (needed by people_search.current_company_ids); column added lazily, db.ts is not touched.
if (!(db.prepare(`PRAGMA table_info(companies)`).all() as { name: string }[]).some((c) => c.name === "company_id")) {
  db.exec(`ALTER TABLE companies ADD COLUMN company_id TEXT`);
}

/** LinkedIn company-size facet codes. */
export const SIZE = {
  "1-10": "B", "11-50": "C", "51-200": "D", "201-500": "E",
  "501-1000": "F", "1001-5000": "G", "5001-10000": "H", "10001+": "I",
} as const;
export type SizeBand = keyof typeof SIZE;

export type CompanySearchParams = {
  keywords: string;
  sizes?: SizeBand[];
  hq_geo_urn?: string; // 106057199 = Brazil
  limit?: number;
};

export function buildCompanyUrl(p: CompanySearchParams, page = 1) {
  const q = new URLSearchParams({ keywords: p.keywords });
  if (p.sizes?.length) q.set("companySize", JSON.stringify(p.sizes.map((s) => SIZE[s])));
  if (p.hq_geo_urn) q.set("companyHqGeo", JSON.stringify([p.hq_geo_urn]));
  if (page > 1) q.set("page", String(page));
  return `https://www.linkedin.com/search/results/companies/?${q}`;
}

export type CompanyCard = {
  url: string; kind: "company" | "showcase"; name: string; industry: string;
  location: string; followers: string; summary: string;
  /** Numeric company id when the card exposes it (usually "" here; companies_enrich reads it from the page). */
  company_id: string;
};

/** Observed card lines: name, industry, location, "Seguir", summary, "... seguidores". */
export function parseCompanyCard(href: string, lines: string[], hrefs: string[] = [href]): CompanyCard {
  const body = lines.filter((l) => !/^(Seguir|Follow|Seguindo|Following)$/.test(l));
  const followers = lines.find((l) => /seguidores|followers/i.test(l)) ?? "";
  return {
    url: href,
    kind: href.includes("/showcase/") ? "showcase" : "company",
    name: body[0] ?? "",
    industry: body[1] ?? "",
    location: body[2] ?? "",
    followers: (followers.match(/([\d.,]+\s*(mil|k)?)\s*(seguidores|followers)/i)?.[1] ?? followers).trim(),
    company_id: extractCompanyId(hrefs),
    summary: body.slice(3).filter((l) => l !== followers && !/^Page da empresa/.test(l)).join(" ").slice(0, 400),
  };
}

export async function searchCompanies(p: CompanySearchParams): Promise<CompanyCard[]> {
  const page = await getPage();
  const limit = p.limit ?? 20;
  const out = new Map<string, CompanyCard>();
  for (let n = 1; out.size < limit && n <= 5 && (n === 1 || hasTime()); n++) {
    await nav(page, buildCompanyUrl(p, n), "search");
    await page.waitForSelector("main a[href*='/company/']", { timeout: 8000 }).catch(() => null);
    await afterAction(page);
    await page.waitForTimeout(1500);
    const cards = await page.evaluate(cardsByLink, "/company/|/showcase/");
    const before = out.size;
    for (const c of cards) {
      const co = parseCompanyCard(c.href, c.lines, c.hrefs);
      if (co.name && co.kind === "company") out.set(co.url, co);
    }
    if (out.size === before) break;
  }
  const list = [...out.values()].slice(0, limit);
  const up = db.prepare(
    `INSERT INTO companies (url,name,industry,location,company_id,last_seen) VALUES (?,?,?,?,NULLIF(?,''),CURRENT_TIMESTAMP)
     ON CONFLICT(url) DO UPDATE SET last_seen=CURRENT_TIMESTAMP, name=COALESCE(NULLIF(excluded.name,''),name), industry=COALESCE(NULLIF(excluded.industry,''),industry),
       location=COALESCE(NULLIF(excluded.location,''),location), company_id=COALESCE(excluded.company_id,company_id)`,
  );
  list.forEach((c) => up.run(c.url, c.name, c.industry, c.location, c.company_id));
  return list;
}

const ABOUT_LABELS = [
  "Site", "Website", "Telefone", "Phone", "Setor", "Industry", "Tamanho da empresa", "Company size",
  "Sede", "Headquarters", "Fundação em", "Founded", "Tipo", "Type", "Especializações", "Specialties",
];

/** /company/<slug>/about/ : label/value pairs + overview text. */
export async function getCompanyAbout(url: string) {
  const base = url.split("?")[0].replace(/\/(about|life|jobs|people|posts)\/?$/, "").replace(/\/$/, "");
  const page = await getPage();
  await nav(page, `${base}/about/`, "company");
  await page.waitForTimeout(2500);
  await afterAction(page);
  const lines = await page.evaluate(mainLines);
  const kv = pairs(lines, ABOUT_LABELS);
  const ovIdx = lines.findIndex((l) => /^(Visão geral|Overview)$/.test(l));
  const assoc = lines.find((l) => /usuários associados|associated members/i.test(l)) ?? "";
  const g = (...k: string[]) => k.map((x) => kv[x]).find(Boolean) ?? "";
  // Numeric id: links of the page (jobs / people filters carry it), else the first company URN embedded in the page.
  const idCandidates = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const hrefs = [...main.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "").filter((h) => /f_C=|currentCompany|\/company\/\d/.test(h));
    const urn = document.documentElement.innerHTML.match(/urn:li:(?:fsd_company|company|organization):\d+/)?.[0] ?? "";
    return [...hrefs, urn];
  });
  const result = {
    url: base,
    company_id: extractCompanyId(idCandidates),
    name: lines[0] ?? "",
    tagline: lines[1] ?? "",
    overview: ovIdx >= 0 ? lines[ovIdx + 1] ?? "" : "",
    website: g("Site", "Website"),
    phone: g("Telefone", "Phone"),
    industry: g("Setor", "Industry"),
    size: g("Tamanho da empresa", "Company size"),
    members_on_linkedin: assoc.match(/[\d.,]+/)?.[0] ?? "",
    headquarters: g("Sede", "Headquarters"),
    founded: g("Fundação em", "Founded"),
    type: g("Tipo", "Type"),
    specialties: g("Especializações", "Specialties"),
  };
  // A 404 / unavailable page is not a company: do not cache it (and do not return chrome text as data).
  if (!result.name || COMPANY_NOT_FOUND.test(lines.slice(0, 6).join(" ")) || (!Object.keys(kv).length && !result.overview)) {
    throw new Error(`COMPANY_PAGE_NOT_FOUND: ${base} did not load as a company About page`);
  }
  saveCompanyAbout(result);
  return result;
}

/** Upsert that never replaces cached data with an empty value. */
export function saveCompanyAbout(r: { url: string; name: string; industry: string; size: string; website: string; headquarters: string; company_id: string }) {
  db.prepare(
    `INSERT INTO companies (url,name,industry,size,website,location,company_id,last_seen) VALUES (?,?,?,?,?,?,NULLIF(?,''),CURRENT_TIMESTAMP)
     ON CONFLICT(url) DO UPDATE SET last_seen=CURRENT_TIMESTAMP, name=COALESCE(NULLIF(excluded.name,''),name), industry=COALESCE(NULLIF(excluded.industry,''),industry),
       size=COALESCE(NULLIF(excluded.size,''),size), website=COALESCE(NULLIF(excluded.website,''),website),
       location=COALESCE(NULLIF(excluded.location,''),location), company_id=COALESCE(excluded.company_id,company_id)`,
  ).run(r.url, r.name, r.industry, r.size, r.website, r.headquarters, r.company_id);
}

/**
 * Company name -> numeric id for people_search. Local cache first; else a company search, accepting only a card whose
 * name matches (never a guess), then the About page for the id. Returns null when no card matches.
 */
export async function resolveCompany(name: string): Promise<{ id: string; name: string; url: string } | null> {
  const row = db
    .prepare(`SELECT url,name,company_id FROM companies WHERE lower(name)=lower(?) AND company_id IS NOT NULL AND company_id<>'' LIMIT 1`)
    .get(name.trim()) as { url: string; name: string; company_id: string } | undefined;
  if (row) return { id: row.company_id, name: row.name, url: row.url };
  const card = pickCompany(name, await searchCompanies({ keywords: name, limit: 5 }));
  if (!card) return null;
  if (card.company_id) return { id: card.company_id, name: card.name, url: card.url };
  const about = await getCompanyAbout(card.url);
  return { id: about.company_id, name: card.name, url: card.url };
}
