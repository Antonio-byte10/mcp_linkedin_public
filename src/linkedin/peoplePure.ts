/**
 * DOM-free and DB-free helpers for people / companies / decision-maker search, so tests never
 * import the browser or open the real linkedin.db.
 */
import { looksLikeCompany } from "../analysis/skills.js";

export type Person = {
  url: string;
  name: string;
  degree: string;
  headline: string;
  location: string;
  current: string;
  role: string;
  company: string;
  mutual: string;
  action: string;
};

export const ACTIONS = /^(Conectar|Connect|Seguir|Follow|Seguindo|Following|Acompanhar|Conectado|Connected|Enviar mensagem|Mensagem|Message|Pendente|Pending)$/;
/** Lines on a search card that are neither headline nor location. */
const BADGE = /^(Premium|Verificado|Verified|Fora da sua rede|Out of your network|Visitar o site|Visit (my )?website|Disponível para trabalho|Open to work|Contratando|Hiring)$/i;

/**
 * "Head de Dados na Hooli" / "Tech Recruiter at X" / "Dev @ Y" / "Engenheiro na Acme em São Paulo" -> role + company.
 * Splits on the first role/company separator (na|no|at|@) whose tail looks like a company (upper-case or digit
 * start, not a skill), cut at a comma/pipe and without a trailing " em <place>". "Consultor na área de dados,
 * Salesforce, SAP" has none: no company rather than a wrong one. A line with only "em" ("Analista em Dados") is a
 * subject, not a company: not split (low confidence).
 */
export function splitCurrent(current: string): { role: string; company: string } {
  const text = current.trim();
  for (const m of text.matchAll(/\s+(?:na|no|at|@)\s+/gi)) {
    const role = text.slice(0, m.index).trim();
    const tail = text.slice((m.index ?? 0) + m[0].length);
    const company = tail.split(/\s*[,|·•]\s*/)[0].replace(/\s+em\s+.+$/i, "").trim();
    if (role && company && looksLikeCompany(company)) return { role, company };
  }
  return { role: text, company: "" };
}

/**
 * "X e mais 3 conexões em comum", "5 mutual connections", "1 conexão em comum": never a person's name. The whole
 * phrase is required, so a name/headline merely containing "mutual" ("Mutual Fund Analyst") is not mistaken for it.
 */
export const isMutualText = (l: string) => /conex(ão|ões|ao|oes) em comum|mutual connections?\b/i.test(l);

/**
 * Person named by a card button or link label ("Convidar X para se conectar", "Invite X to connect", "Seguir X",
 * "Follow X", "Ver perfil de X", "View X’s profile").
 */
export function nameFromButton(label: string): string {
  const m =
    label.match(/^(?:Convidar|Invite)\s+(.+?)\s+(?:para se conectar|to connect)$/i) ??
    label.match(/^(?:Seguir|Follow)\s+(.+)$/i) ??
    label.match(/^Ver perfil de\s+(.+)$/i) ??
    label.match(/^View\s+(.+?)[’']s\s+profile$/i);
  const n = m?.[1].trim() ?? "";
  return n && !isMutualText(n) ? n : "";
}

/**
 * Observed card lines: name, "• 2º", headline, location, action, "Atual: X na Y", "... conexões em comum".
 * Optional lines are matched by pattern, not position. When the mutual-connections text lands on the first
 * line it must not become the name: use a button label, else the line right before the degree, else no name
 * (the caller drops nameless rows; a wrong name could get an invite sent to the wrong person).
 */
export function parsePersonCard(href: string, raw: string[], buttons: string[] = []): Person {
  // degree sometimes shares the name line: "Name • 2º"
  const m = raw[0]?.match(/^(.*?)\s*•\s*(\d.*)$/);
  let lines = m ? [m[1], `• ${m[2]}`, ...raw.slice(1)] : raw;
  if (lines[0] !== undefined && isMutualText(lines[0])) {
    const di = lines.findIndex((l) => /^•\s*\d/.test(l));
    const before = di > 1 ? lines[di - 1] : "";
    const alt = buttons.map(nameFromButton).find(Boolean) ?? (before && !isMutualText(before) && !ACTIONS.test(before) ? before : "");
    // keep the mutual line in the list so it still fills `mutual`
    lines = [alt, lines[0], ...lines.slice(1).filter((l) => l !== alt)];
  }
  const degIdx = lines.findIndex((l) => /^•\s*\d/.test(l));
  const rest = lines.filter((_, i) => i !== 0 && i !== degIdx);
  const isMeta = (l: string) => ACTIONS.test(l) || BADGE.test(l) || /^(Atual|Current|Anterior|Past):/i.test(l) || isMutualText(l);
  const core = rest.filter((l) => !isMeta(l));
  const current = rest.find((l) => /^(Atual|Current):/i.test(l))?.replace(/^(Atual|Current):\s*/i, "") ?? "";
  return {
    url: href,
    name: lines[0] ?? "",
    degree: degIdx >= 0 ? lines[degIdx].replace(/^•\s*/, "") : "",
    headline: core[0] ?? "",
    location: core[1] ?? "",
    current,
    ...splitCurrent(current),
    mutual: rest.find(isMutualText) ?? "",
    action: rest.find((l) => ACTIONS.test(l)) ?? "",
  };
}

// ---- company ids ----

const ID_PATTERNS: RegExp[] = [
  /urn:li:(?:fsd_company|company|organization|fs_normalized_company|fs_miniCompany):(\d{3,})/i,
  /[?&]f_C=(\d{3,})/i,
  /[?&](?:currentCompany|companyIds?|facetCurrentCompany)=[^&]*?(\d{3,})/i,
  /\/company\/(\d{3,})(?:[/?#]|$)/i,
];
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Numeric LinkedIn company id from URNs / hrefs / urls (first hit in the given order), or "". */
export function extractCompanyId(candidates: string[]): string {
  for (const raw of candidates) {
    const s = decode(String(raw ?? ""));
    for (const re of ID_PATTERNS) {
      const m = s.match(re);
      if (m) return m[1];
    }
  }
  return "";
}

const COMPANY_NOISE = /\b(ltda|s a|sa|inc|llc|eireli|me|epp|corp|corporation)\b/g;
export const normCompany = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();

/**
 * The search card that IS the company asked for: same normalised name, else one name starting with the other
 * (word boundary). Never guesses: a wrong company would mean contacting the wrong people.
 */
export function pickCompany<T extends { name: string }>(query: string, cards: T[]): T | undefined {
  const q = normCompany(query);
  if (!q) return undefined;
  const named = cards.map((c) => ({ c, n: normCompany(c.name) })).filter((x) => x.n);
  return named.find((x) => x.n === q)?.c ?? named.find((x) => x.n.startsWith(`${q} `) || q.startsWith(`${x.n} `))?.c;
}

/** Not-found / unavailable pages must not be cached as companies. */
export const COMPANY_NOT_FOUND = /não existe|nao existe|página não encontrada|page not found|this page doesn.t exist|não está disponível|isn.t available/i;

// ---- decision makers ----

export const DEFAULT_ROLES = ["technical recruiter", "talent acquisition", "head de dados", "data manager", "tech lead"];
export const MAX_COMPANIES = 10;
export const MAX_ROLES = 8;
const RESOLVE_NEED_MS = 20000;
const SEARCH_NEED_MS = 12000;

export type Lead = { company: string; company_id: string; person: string; role: string; headline: string; current_role: string; degree: string; url: string; action: string };
export type LeadsInput = { company_names?: string[]; company_ids?: string[]; roles?: string[]; limit_per_company?: number };
export type LeadsDeps = {
  resolve(name: string): Promise<{ id: string; name: string } | null>;
  search(p: { keywords: string; current_company_ids: string[]; limit: number }): Promise<Person[]>;
  hasTime(needMs: number): boolean;
  isAccountError(msg: string): boolean;
};
export type LeadsOutput = {
  leads: Lead[];
  unresolved: { company: string; reason: string }[];
  errors: { company: string; role?: string; error: string }[];
  left: { company: string; roles: string[] }[];
  stopped?: string;
};

/** Profile url without query/fragment/trailing slash, lowercased: the dedupe key. */
export const leadKey = (url: string) => url.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();

export function cleanRoles(roles: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roles?.length ? roles : DEFAULT_ROLES) {
    const t = r.replace(/\s+/g, " ").trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, MAX_ROLES);
}

/**
 * Role-by-role people search scoped to each company id, deduped by profile URL. Read-only.
 * Always tries the first unit of work; afterwards each page-loading step needs time left, otherwise the
 * rest is reported in `left` (call again). Account-level errors stop the whole run but keep partial leads.
 */
export async function runLeads(deps: LeadsDeps, input: LeadsInput): Promise<LeadsOutput> {
  const roles = cleanRoles(input.roles);
  const perCompany = Math.min(Math.max(input.limit_per_company ?? 10, 1), 25);
  const targets: { label: string; name?: string; id?: string }[] = [];
  const seenTarget = new Set<string>();
  for (const n of input.company_names ?? []) {
    const t = n.trim();
    if (t && !seenTarget.has(`n:${t.toLowerCase()}`)) {
      seenTarget.add(`n:${t.toLowerCase()}`);
      targets.push({ label: t, name: t });
    }
  }
  for (const i of input.company_ids ?? []) {
    if (!seenTarget.has(`i:${i}`)) {
      seenTarget.add(`i:${i}`);
      targets.push({ label: `company_id:${i}`, id: i });
    }
  }
  const out: LeadsOutput = { leads: [], unresolved: [], errors: [], left: [] };
  const keys = new Set<string>();
  let first = true;
  const need = (ms: number) => first || deps.hasTime(ms);
  const errMsg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const stopRest = (fromRole: number, label: string, why?: string) => {
      out.left.push({ company: label, roles: roles.slice(fromRole) });
      for (const u of targets.slice(ti + 1)) out.left.push({ company: u.label, roles });
      if (why) out.stopped = why;
      return out;
    };
    let id = t.id;
    let label = t.label;
    if (!id) {
      if (!need(RESOLVE_NEED_MS)) return stopRest(0, label);
      first = false;
      try {
        const r = await deps.resolve(t.name as string);
        if (!r || !r.id) {
          out.unresolved.push({
            company: t.label,
            reason: r ? "company found but its numeric id could not be read (pass company_ids)" : "no company with this name in the search results",
          });
          continue;
        }
        id = r.id;
        label = r.name || t.label;
      } catch (e) {
        const msg = errMsg(e);
        if (deps.isAccountError(msg)) return stopRest(0, label, msg);
        out.errors.push({ company: t.label, error: msg });
        continue;
      }
    }
    let count = 0;
    for (let ri = 0; ri < roles.length && count < perCompany; ri++) {
      if (!need(SEARCH_NEED_MS)) return stopRest(ri, label);
      first = false;
      try {
        const people = await deps.search({ keywords: roles[ri], current_company_ids: [id], limit: Math.min(perCompany - count, 10) });
        for (const p of people) {
          const key = leadKey(p.url);
          if (!key || keys.has(key) || count >= perCompany) continue;
          keys.add(key);
          count++;
          out.leads.push({ company: label, company_id: id, person: p.name, role: roles[ri], headline: p.headline, current_role: p.role, degree: p.degree, url: p.url, action: p.action });
        }
      } catch (e) {
        const msg = errMsg(e);
        if (deps.isAccountError(msg)) return stopRest(ri, label, msg);
        out.errors.push({ company: label, role: roles[ri], error: msg });
      }
    }
  }
  return out;
}
