/**
 * Answer-bank resolver: one Easy Apply question -> one answer from <data folder>/answers.json.
 * Pure (no DOM, no fs), so every rule is tested offline against the saved form maps.
 *
 * Order (audit C.2): LinkedIn semantic key -> approved alias (answers.learned[]) -> regex families
 * on the normalised label (PT + EN) and option fingerprints -> null.
 * It never invents: an unknown question, a family whose bank value is null, a missing option, or two
 * families that disagree all give null, and the caller reports the field as unanswered (stop_and_ask).
 * Labels and options are third-party text: they only select a family, the value always comes from the bank.
 */
import { strs, type Answers } from "./bank.js";
import type { FieldKind } from "../linkedin/mapperPure.js";

export type Lang = "pt" | "en";
export type JobLang = Lang | "bilingual";

/** What is known about the job being applied to (from the local cache). */
export type JobCtx = {
  title?: string | null;
  description?: string | null;
  company?: string | null;
  location?: string | null;
  /** detectLanguage(title + description); computed by the caller once per job. */
  language?: JobLang | null;
  /** ISO-like code (BR, PT, US, ...) from jobCountry(location). */
  country?: string | null;
};

export type AnswerValue = string | string[] | boolean;

export type Resolution = {
  /** text kinds: the text; select/radio: the exact option text; checkbox_group: option texts; checkbox: checked. */
  value: AnswerValue;
  /** Bank path or rule that produced it, e.g. "skills.excel.years", "policy.skills_not_listed". */
  source: string;
  /** Needs the one-time sensitive confirmation (CPF, salary, benefits). Never logged in clear. */
  sensitive?: boolean;
  /** Personal data (name, e-mail, phone, URLs): filled normally, masked in logs. */
  pii?: boolean;
  /** Derived from a policy (skills_not_listed), not an explicit bank entry: never overrides a prefill. */
  policy?: boolean;
};

export type ResolveExtra = {
  /** LinkedIn semantic key of the field (FIRST_NAME, PHONE_MOBILE, RESUME, custom ...). */
  key?: string;
  ctx?: JobCtx;
  /** Currently selected option(s) (resume radio keeps the preselected one when it is the right language). */
  selected?: string[];
  /** Mapper flag: "Se sim..." follow-up question. */
  conditional?: boolean;
  /** The previous question on the step was answered No/none (a "Se sim..." follow-up is then NA). */
  previousNo?: boolean;
  /** Some radio/checkbox options had no readable text (mapper "(sem rótulo N)"). */
  unlabeled?: boolean;
  max_length?: number;
  /** Field hint + placeholder (e.g. "Valor mensal PJ", "USD"). */
  hint?: string;
};

export type Detailed = { res: Resolution; reason?: undefined } | { res: null; reason: string };

// --- text helpers ------------------------------------------------------------------------------

/** Accent- and case-insensitive, whitespace collapsed. */
export const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** norm() with punctuation turned into spaces ("Resume_EN.pdf" -> "resume en pdf"). */
export const loose = (s: string | null | undefined) => norm(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRes = new Map<string, RegExp>();
/** Whole-word containment on loose() text. */
export function hasWord(hay: string, word: string): boolean {
  const w = loose(word);
  if (!w) return false;
  let re = wordRes.get(w);
  if (!re) {
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, "u");
    wordRes.set(w, re);
  }
  return re.test(loose(hay));
}

const PLACEHOLDER = /^(selecionar opcao|select an option|selecione|escolha|choose|--+)/;
export const isPlaceholder = (o: string) => PLACEHOLDER.test(norm(o));
const TRUNCATED = /^… \(\d+ options total\)$/;
const realOptions = (options: string[] | undefined) => (options ?? []).filter((o) => o && !isPlaceholder(o) && !TRUNCATED.test(o));

const YES = /^(sim|yes|si)\b/;
const NO = /^(nao|no)\b/;

/**
 * Picks the one option equal to `wanted` (accent/case/punctuation-insensitive), else the one option that
 * contains it as whole words. 0 or several candidates -> null (never a guess).
 */
export function fuzzyOption(options: string[] | undefined, wanted: string | null | undefined): string | null {
  const w = loose(wanted);
  if (!w) return null;
  const opts = realOptions(options);
  const eq = opts.filter((o) => loose(o) === w);
  if (eq.length) return eq.length === 1 ? eq[0] : null;
  const has = opts.filter((o) => hasWord(o, w));
  return has.length === 1 ? has[0] : null;
}

/** The single option whose norm() text satisfies `re`; null when 0 or more than 1 match. */
function uniqueOption(options: string[] | undefined, re: RegExp): string | null {
  const hit = realOptions(options).filter((o) => re.test(norm(o)));
  return hit.length === 1 ? hit[0] : null;
}

// --- job context -------------------------------------------------------------------------------

const PT_WORDS = new Set("de da do das dos e em para com que uma um voce nao sao na no nos nas pelo pela como mais ou ao aos sua seu suas seus experiencia vaga conhecimento atividades requisitos empresa trabalho area responsabilidades beneficios desejavel".split(" "));
const EN_WORDS = new Set("the and of to in for with you we our your is are will be an as on this that by experience job team skills requirements work responsibilities benefits role about who what".split(" "));

/** Stopword (and diacritic) counts for PT and EN. */
function langScore(text: string | null | undefined): { pt: number; en: number } {
  const words = loose(text).split(" ").filter(Boolean).slice(0, 4000);
  let pt = 0;
  let en = 0;
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++;
    else if (EN_WORDS.has(w)) en++;
  }
  // Raw diacritics only exist in Portuguese here.
  pt += Math.min(10, ((text ?? "").normalize("NFC").match(/[ãõçâêôáéíóú]/gi) ?? []).length / 3);
  return { pt, en };
}

/**
 * Job language from title + description by a stopword count. "bilingual" when both languages carry
 * a real share of a long text; null when the signal is weak (fewer than 5 signal words).
 */
export function detectLanguage(text: string | null | undefined): JobLang | null {
  const { pt, en } = langScore(text);
  const total = pt + en;
  // A title alone ("Analista de Dados") is not enough to choose a resume: below 5 signal words, unknown.
  if (total < 5) return null;
  if (total >= 12) {
    const r = pt / total;
    if (r >= 0.75) return "pt";
    if (r <= 0.25) return "en";
    return "bilingual";
  }
  // Short text: a clear majority only.
  if (pt >= 2 * en) return "pt";
  if (en >= 2 * pt) return "en";
  return null;
}

// Brazilian UFs that are not also US state codes (PA, SC, AL, MA, MS, MT are both).
const BR_UF = new Set("ac ap am ba ce df es go mg pb pr pe pi rj rn rs ro rr sp se to".split(" "));
const BR_PLACES = /\b(brasil|brazil|sao paulo|rio de janeiro|minas gerais|parana|santa catarina|rio grande do sul|bahia|pernambuco|ceara|goias|distrito federal|espirito santo|belo horizonte|curitiba|porto alegre|florianopolis|recife|salvador|fortaleza|brasilia|campinas|santo andre|sao bernardo do campo|guarulhos|niteroi|joinville|manaus|belem)\b/;
const COUNTRIES: [RegExp, string][] = [
  [/\bportugal\b|\blisboa\b|\blisbon\b|\bporto, portugal/, "PT"],
  [/\b(united states|estados unidos|usa|eua)\b/, "US"],
  [/\b(espanha|spain|espana)\b/, "ES"],
  [/\b(alemanha|germany|deutschland)\b/, "DE"],
  [/\b(franca|france)\b/, "FR"],
  [/\b(irlanda|ireland)\b/, "IE"],
  [/\b(holanda|netherlands|paises baixos)\b/, "NL"],
  [/\b(italia|italy)\b/, "IT"],
  [/\b(belgica|belgium)\b/, "BE"],
  [/\b(reino unido|united kingdom|england|inglaterra)\b/, "GB"],
  [/\b(canada)\b/, "CA"],
  [/\b(mexico)\b/, "MX"],
  [/\b(argentina)\b/, "AR"],
  [/\b(chile)\b/, "CL"],
  [/\b(colombia)\b/, "CO"],
];
export const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));

/** Country of a LinkedIn job location ("Campinas, SP (Híbrido)", "Lisboa, Portugal"); null when unknown. */
export function jobCountry(location: string | null | undefined): string | null {
  const l = norm(location).replace(/\((remoto|hibrido|presencial|remote|hybrid|on-site)\)/g, "").trim();
  if (!l) return null;
  for (const [re, c] of COUNTRIES) if (re.test(l)) return c;
  if (BR_PLACES.test(l)) return "BR";
  const parts = l.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && BR_UF.has(parts[parts.length - 1])) return "BR";
  return null;
}

/** PT and EN option text for a country code (a "where are you based?" select). */
const COUNTRY_NAMES: Record<string, [string, string]> = {
  BR: ["Brasil", "Brazil"], PT: ["Portugal", "Portugal"], US: ["Estados Unidos", "United States"], ES: ["Espanha", "Spain"],
  DE: ["Alemanha", "Germany"], FR: ["França", "France"], IE: ["Irlanda", "Ireland"], NL: ["Holanda", "Netherlands"], IT: ["Itália", "Italy"],
  BE: ["Bélgica", "Belgium"], GB: ["Reino Unido", "United Kingdom"], CA: ["Canadá", "Canada"], MX: ["México", "Mexico"],
  AR: ["Argentina", "Argentina"], CL: ["Chile", "Chile"], CO: ["Colômbia", "Colombia"],
};

const regionOf = (country: string) => (country === "BR" ? "BR" : country === "US" ? "US" : country === "EU" || EU.has(country) ? "EU" : "other");

/** "o país para o qual está se candidatando", "this country", "the country of the job": the job's own country. */
const GENERIC_PLACE = /^(this|that|the|your|o|a|este|esse|neste|nesse)? ?(country|pais|location|local|region|regiao|localidade)\b|^(pais|country) (para o qual|for which|where|in which|of)/;

/**
 * Country a work-authorization / sponsorship question names ("authorized to work in the United States?").
 * named=false: the question means the job's country. named=true with country=null: a place we cannot map
 * (the caller must not answer for the job country instead).
 */
export function questionCountry(L: string): { named: boolean; country: string | null } {
  const m = L.match(/(?:work|working|trabalhar|trabalho|employment|emprego) (?:legally |legalmente )?(?:in|no|na|nos|nas|em|within|dentro d[oa]) (?:the |o |a |os |as )?([^?,;:()]+)/);
  if (!m) return { named: false, country: null };
  const place = m[1].trim();
  if (!place || GENERIC_PLACE.test(place)) return { named: false, country: null };
  if (/^(european union|uniao europeia|eu|ue|europe|europa)\b/.test(place)) return { named: true, country: "EU" };
  if (/^(us|u\.s\.?(a\.?)?|usa|eua)\b/.test(place)) return { named: true, country: "US" };
  if (/^(brasil|brazil)\b/.test(place)) return { named: true, country: "BR" };
  return { named: true, country: jobCountry(place) };
}

/** Country a work-auth question is about: the named one (must agree with a known job country), else the job's. */
function authCountry(L: string, x: ResolveExtra): { country: string } | { fail: string } {
  const q = questionCountry(L);
  const job = x.ctx?.country ?? null;
  if (!q.named) return job ? { country: job } : { fail: "unknown_job_country" };
  if (!q.country) return { fail: "question_country_unknown" };
  if (job && q.country !== job && !(q.country === "EU" && EU.has(job))) return { fail: `question_country_${q.country}_differs_from_job_${job}` };
  return { country: q.country };
}

// --- skills ------------------------------------------------------------------------------------

type Skill = { key: string; aliases: string[]; years: unknown; knows: unknown };
const skillsOf = (a: Answers): Skill[] =>
  (Array.isArray(a.skills) ? a.skills : []).filter((s: unknown): s is Skill => !!s && typeof (s as Skill).key === "string");

/** Words that may sit around a skill name without changing which skill is asked about. */
const SKILL_FILLER = new Set(
  "a o as os the de da do das dos em no na nos nas com with in of using usando uso ferramenta ferramentas tool tools software plataforma platform linguagem language skills habilidades conhecimento conhecimentos".split(" "),
);

/**
 * The bank skill named by a question phrase ("Microsoft Excel", "Artificial Intelligence (AI)").
 * Aliases are matched as whole words, longest first, without overlap. Then:
 * - two different skills ("Python and SQL") -> "ambiguous" (one number/answer cannot be true for both);
 * - one skill plus other significant words ("SQL Server", "Python and Django") -> "partial" (an unknown term);
 * - no skill -> null.
 */
export function findSkill(phrase: string, a: Answers): Skill | "ambiguous" | "partial" | null {
  const p = loose(phrase);
  if (!p) return null;
  const hits: { s: Skill; x: string }[] = [];
  for (const s of skillsOf(a)) {
    for (const al of [s.key.replace(/_/g, " "), ...(Array.isArray(s.aliases) ? s.aliases : [])]) {
      const x = loose(al);
      if (x && (p === x || hasWord(p, x))) hits.push({ s, x });
    }
  }
  if (!hits.length) return null;
  hits.sort((m, n) => n.x.length - m.x.length);
  // Consume the phrase longest-alias first; what remains must be filler words only.
  let rest = ` ${p} `;
  const used = new Set<Skill>();
  for (const h of hits) {
    const at = rest.indexOf(` ${h.x} `);
    if (at < 0) continue;
    rest = `${rest.slice(0, at)} ${rest.slice(at + h.x.length + 1)}`;
    used.add(h.s);
  }
  if (used.size > 1) return "ambiguous";
  const left = rest.split(" ").filter((w) => w && !SKILL_FILLER.has(w) && !/^(and|e|or|ou|\d+)$/.test(w));
  if (left.length) return "partial";
  return [...used][0] ?? null;
}

/**
 * policy.skills_not_listed ("0 years / No") is only true for a named tool or technology ("Tableau",
 * "Account Planning"), not for a role, an industry or a soft skill ("years in the IT industry",
 * "similar role", "gestão de equipes", "stakeholder management"): those stay unanswered.
 */
const NOT_A_TOOL = /(^| )(the|a|an|this|that|these|those|your|our|o|os|as|um|uma|este|esta|esse|essa|seu|sua|similar|semelhante|industry|industria|setor|sector|segmento|ramo|area|field|role|roles|cargo|cargos|funcao|position|posicao|gestao|management|managing|manager|team|teams|equipe|equipes|time|lideranca|leadership|lider|leading|clientes|cliente|clients|client|customers|customer|stakeholders?|pessoas|people)( |$)/;
export function toolLike(phrase: string): boolean {
  const p = loose(phrase);
  const n = p.split(" ").filter(Boolean).length;
  return n > 0 && n <= 3 && !NOT_A_TOOL.test(p);
}

/** "Quantos anos de experiência com X você tem?": the trailing "você tem" is not part of the skill. */
const skillPhrase = (s: string) => s.trim().replace(/\s+(?:voce (?:tem|possui)|do you (?:currently )?have)$/, "").trim();

const ANY_OF = /^(?:(?:at least )?(?:one|any) of(?: the following)?|(?:pelo menos )?(?:um|uma|algum|alguma) (?:dos|das|de)(?: seguintes)?)\s*:?\s*/;
/**
 * Items of an OR list ("Tableau or Looker or Qlik", "one of the following: SQL, Python, or R",
 * "Power BI ou Looker Studio (Google Data Studio)"), else null. "and"/"e" never splits: it can be part of a name.
 */
export function orItems(phrase: string): string[] | null {
  const n = norm(phrase).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const p = n.replace(ANY_OF, "");
  if (p === n && !/\b(or|ou)\b/.test(p)) return null;
  const items = p.split(/\s*(?:,|;|\/|\bor\b|\bou\b)\s*/).map((s) => s.trim()).filter(Boolean);
  return items.length >= 2 ? items : null;
}

/** Every item of an OR list is a tool-like name outside the bank: 0 years / No is true for all of them. */
const allUnlisted = (items: string[] | null, a: Answers) => !!items && items.every((i) => findSkill(i, a) === null && toolLike(i));

// --- resume ------------------------------------------------------------------------------------

/** Language a saved-resume option is written in, from file-name tokens ("Resume_EN.pdf", "CV_PT.pdf"). */
export function optionLanguage(option: string): Lang | null {
  const t = new Set(loose(option).split(" "));
  const en = ["en", "eng", "english", "ingles", "resume", "cv en"].some((w) => t.has(w));
  const pt = ["pt", "ptbr", "br", "portugues", "curriculo"].some((w) => t.has(w));
  return en === pt ? null : en ? "en" : "pt";
}

/**
 * Saved-resume radio for the job language: the option whose text holds documents.resume_by_language[lang]
 * (bilingual -> whatever resume_by_language.bilingual points to). If none matches, the preselected
 * option is kept only when it is itself in the expected language.
 */
export function pickResume(options: string[] | undefined, selected: string[] | undefined, a: Answers, lang: JobLang | null | undefined): Detailed {
  const rbl = a.documents?.resume_by_language ?? {};
  if (!lang) return { res: null, reason: "unknown_job_language" };
  const key: unknown = lang === "bilingual" ? rbl.bilingual : lang;
  if (key !== "pt" && key !== "en") return { res: null, reason: "no_bank_value:documents.resume_by_language.bilingual" };
  const file: unknown = rbl[key];
  const source = `documents.resume_by_language.${key}`;
  if (typeof file === "string" && file.trim()) {
    const f = loose(file);
    const stem = loose(file.replace(/\.[a-z0-9]{2,4}$/i, ""));
    const hit = realOptions(options).filter((o) => loose(o).includes(f) || (stem.length >= 3 && hasWord(o, stem)));
    if (hit.length === 1) return { res: { value: hit[0], source } };
    if (hit.length > 1) return { res: null, reason: "ambiguous_resume" };
  }
  const sel = selected?.[0];
  if (sel && optionLanguage(sel) === key) return { res: { value: sel, source: `${source} (preselected)` } };
  return { res: null, reason: `resume_${key}_not_found` };
}

// --- intents -----------------------------------------------------------------------------------

/** What a family wants; materialize() turns it into a value for the field kind and its options. */
type Intent =
  | { t: "text"; v: string }
  | { t: "num"; v: number }
  | { t: "yn"; v: boolean }
  | { t: "pick"; pick: (options: string[]) => string[] | null };

type Hit = { intent: Intent; source: string; sensitive?: boolean; pii?: boolean; policy?: boolean };
/** null = family does not apply; {fail} = the family applies but cannot answer (bank null, unknown country...). */
type FamilyOut = Hit | { fail: string; source: string } | null;

const TEXT_KINDS = new Set<FieldKind>(["text", "number", "email", "tel", "url", "textarea", "typeahead", "date"]);

function numInRangeOption(options: string[], v: number): string | null {
  const hits = realOptions(options).filter((o) => {
    const n = norm(o);
    const nums = (n.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => Number(x.replace(",", ".")));
    if (!nums.length) return /^(nenhum|none|zero|sem experiencia|no experience)/.test(n) && v === 0;
    if (/(\+|mais de|more than|acima de|over|or more|ou mais)/.test(n) && nums.length === 1) return v >= nums[0];
    if (/(menos de|less than|under|abaixo de)/.test(n) && nums.length === 1) return v < nums[0];
    if (nums.length >= 2) return v >= nums[0] && v <= nums[1];
    return v === nums[0];
  });
  return hits.length === 1 ? hits[0] : null;
}

function materialize(i: Intent, kind: FieldKind, options: string[] | undefined): AnswerValue | null {
  const opts = realOptions(options);
  switch (i.t) {
    case "text":
      if (TEXT_KINDS.has(kind)) return i.v;
      if (kind === "select" || kind === "radio") return fuzzyOption(opts, i.v);
      return null;
    case "num":
      if (TEXT_KINDS.has(kind)) return String(i.v);
      if (kind === "select" || kind === "radio") return numInRangeOption(opts, i.v);
      return null;
    case "yn": {
      if (kind === "checkbox") return opts.length <= 1 ? i.v : null;
      if (kind !== "select" && kind !== "radio" && kind !== "checkbox_group") return null;
      const o = uniqueOption(opts, i.v ? YES : NO);
      if (!o) return null;
      return kind === "checkbox_group" ? [o] : o;
    }
    case "pick": {
      if (kind !== "select" && kind !== "radio" && kind !== "checkbox_group") return null;
      const got = i.pick(opts);
      if (!got || !got.length) return null;
      if (kind === "checkbox_group") return got;
      return got.length === 1 ? got[0] : null;
    }
  }
}

const sameValue = (a: AnswerValue, b: AnswerValue) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

// --- families ----------------------------------------------------------------------------------

type FamilyArgs = { L: string; raw: string; kind: FieldKind; options: string[]; a: Answers; x: ResolveExtra; labelLang: Lang | null };
type Family = (f: FamilyArgs) => FamilyOut;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const get = (a: Answers, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), a);

/** Text from the bank at `path`, or a fail record when it is null/missing. */
const textAt = (a: Answers, path: string, extra: Partial<Hit> = {}): FamilyOut => {
  const v = str(get(a, path));
  return v === null ? { fail: `no_bank_value:${path}`, source: path } : { intent: { t: "text", v }, source: path, ...extra };
};
const ynAt = (a: Answers, path: string, extra: Partial<Hit> = {}): FamilyOut => {
  const v = bool(get(a, path));
  return v === null ? { fail: `no_bank_value:${path}`, source: path } : { intent: { t: "yn", v }, source: path, ...extra };
};

/** pt/en text variant: label language first, then job language, then pt. */
const langOf = (f: FamilyArgs): Lang => f.labelLang ?? (f.x.ctx?.language === "en" ? "en" : f.x.ctx?.language === "pt" ? "pt" : "pt");

/** A Yes/No question: a single checkbox, or exactly one Sim/Yes and one Não/No option (at most 3 real options). */
const yesNoKind = (f: FamilyArgs) => {
  if (f.kind === "checkbox") return true;
  if (f.kind !== "radio" && f.kind !== "select" && f.kind !== "checkbox_group") return false;
  const o = realOptions(f.options).map(norm);
  return o.length <= 3 && o.filter((x) => YES.test(x)).length === 1 && o.filter((x) => NO.test(x)).length === 1;
};

// Contact fields by label (when LinkedIn gives no semantic key).
const contact: Family = ({ L, a }) => {
  if (/^(first name|nome|primeiro nome|given name)$/.test(L)) return textAt(a, "profile.first_name", { pii: true });
  if (/^(last name|sobrenome|ultimo nome|family name|surname)$/.test(L)) return textAt(a, "profile.last_name", { pii: true });
  if (/^(full name|nome completo|seu nome completo)$/.test(L)) {
    const fn = str(a.profile?.first_name);
    const ln = str(a.profile?.last_name);
    return fn && ln ? { intent: { t: "text", v: `${fn} ${ln}` }, source: "profile.first_name+last_name", pii: true } : { fail: "no_bank_value:profile.first_name", source: "profile" };
  }
  if (/^(e-?mail|email address|e-?mail address|endereco de e-?mail|seu e-?mail)$/.test(L)) return textAt(a, "profile.email", { pii: true });
  if (/^(phone|phone number|mobile phone( number)?|telefone|celular|numero de (celular|telefone)|telefone celular|whatsapp)$/.test(L)) return textAt(a, "profile.phone.national", { pii: true });
  if (/^(codigo do pais|country code|phone country code|codigo de pais)$/.test(L)) return textAt(a, "profile.phone.country_option");
  return null;
};

const SKILL_YEARS: RegExp[] = [
  /^ha quantos anos (?:voce )?(?:ja )?(?:usa|utiliza|trabalha com|atua com|tem experiencia (?:com|em)|possui experiencia (?:com|em)) (.+?)(?: no trabalho| profissionalmente| na sua carreira)?$/,
  /quantos anos de experiencia (?:voce )?(?:(?:tem|possui) )?(?:com|em|de) (.+)$/,
  /^tempo de experiencia (?:com|em) (.+)$/,
  /how many years (?:of )?(?:work |professional |hands-on |relevant )?experience (?:do you have )?(?:with|in|using) (.+)$/,
  /how many years of (.+?) experience do you (?:currently )?have$/,
  /how many years have you (?:been )?(?:used|using|worked with|working with) (.+)$/,
];
const TOTAL_YEARS = /^(?:quantos )?anos de experiencia(?: profissional)?(?: total)?$|^(?:how many )?years of (?:total |professional |work )?experience(?: do you have)?$|^ha quantos anos voce trabalha$/;
const DATA_PHRASE = /^(dados|data|area de dados|analytics|data area|the data field)$/;

const skillYears: Family = ({ L, a }) => {
  if (TOTAL_YEARS.test(L)) {
    const n = num(a.profile?.total_years_experience);
    return n === null ? { fail: "no_bank_value:profile.total_years_experience", source: "profile.total_years_experience" } : { intent: { t: "num", v: n }, source: "profile.total_years_experience" };
  }
  let phrase: string | null = null;
  for (const re of SKILL_YEARS) {
    const m = L.match(re);
    if (m) {
      phrase = skillPhrase(m[1]);
      break;
    }
  }
  if (phrase === null) return null;
  const s = findSkill(phrase, a);
  if (s === "ambiguous") return { fail: "several_skills_in_one_question", source: "skills" };
  if (s === "partial") return { fail: "unknown_term_in_skill_question", source: "skills" };
  if (s) {
    const y = num(s.years);
    if (y === null) return { fail: `no_bank_value:skills.${s.key}.years`, source: `skills.${s.key}.years` };
    const total = num(a.profile?.total_years_experience);
    // A bank that contradicts itself (I13) must not be sent to a recruiter.
    if (total !== null && y > total) return { fail: `bank_inconsistent:skills.${s.key}.years>total`, source: `skills.${s.key}.years` };
    return { intent: { t: "num", v: y }, source: `skills.${s.key}.years` };
  }
  if (DATA_PHRASE.test(loose(phrase))) {
    const n = num(a.profile?.years_in_data);
    return n === null ? { fail: "no_bank_value:profile.years_in_data", source: "profile.years_in_data" } : { intent: { t: "num", v: n }, source: "profile.years_in_data" };
  }
  if (a.policy?.skills_not_listed === "zero_years_and_no" && (toolLike(phrase) || allUnlisted(orItems(phrase), a))) return { intent: { t: "num", v: 0 }, source: "policy.skills_not_listed", policy: true };
  return { fail: "skill_not_in_bank", source: "skills" };
};

const KNOW_NOUN = "(?:conhecimento|conhecimentos|experiencia|familiaridade)";
const KNOWS: RegExp[] = [
  new RegExp(`^voce (?:tem|possui) (?:algum |alguma )?${KNOW_NOUN}(?: e ${KNOW_NOUN})? (?:de|em|com|no|na|nos|nas|sobre) (.+)$`),
  /^(?:voce )?ja (?:trabalhou|atuou) com (.+)$/,
  /^do you have (?:any )?(?:prior |previous |hands-on )?(?:experience|knowledge|familiarity) (?:with|in|of|using) (.+)$/,
  /^have you (?:ever )?(?:worked with|used) (.+)$/,
  /^are you (?:familiar|proficient|experienced) (?:with|in) (.+)$/,
];
const knows: Family = ({ L, a }) => {
  let phrase: string | null = null;
  for (const re of KNOWS) {
    const m = L.match(re);
    if (m) {
      phrase = skillPhrase(m[1]);
      break;
    }
  }
  if (!phrase) return null;
  // "A or B" / "one of the following": knowing any one of them makes "Yes" true.
  const items = orItems(phrase);
  if (items) {
    const known = items.map((i) => findSkill(i, a)).find((s): s is Skill => !!s && typeof s === "object" && bool(s.knows) === true);
    if (known) return { intent: { t: "yn", v: true }, source: `skills.${known.key}.knows` };
    if (a.policy?.skills_not_listed === "zero_years_and_no" && allUnlisted(items, a)) return { intent: { t: "yn", v: false }, source: "policy.skills_not_listed", policy: true };
  }
  const s = findSkill(phrase, a);
  if (s === "ambiguous") return { fail: "several_skills_in_one_question", source: "skills" };
  if (s === "partial") return { fail: "unknown_term_in_skill_question", source: "skills" };
  if (s) {
    const k = bool(s.knows);
    return k === null ? { fail: `no_bank_value:skills.${s.key}.knows`, source: `skills.${s.key}.knows` } : { intent: { t: "yn", v: k }, source: `skills.${s.key}.knows` };
  }
  if (a.policy?.skills_not_listed === "zero_years_and_no" && toolLike(phrase)) return { intent: { t: "yn", v: false }, source: "policy.skills_not_listed", policy: true };
  return { fail: "skill_not_in_bank", source: "skills" };
};

const LINKEDIN_SCALE = ["none", "conversational", "professional", "native or bilingual"];
/** The same LinkedIn scale as the PT UI writes it ("Nenhuma / Conversação / Proficiente / Nativo ou bilíngue"). */
const LINKEDIN_SCALE_PT: Record<string, string> = { none: "nenhuma", conversational: "conversacao", professional: "proficiente", "native or bilingual": "nativo ou bilingue" };
const LEVEL_RES: Record<string, RegExp[]> = {
  none: [/^(nao tenho|nenhum|none|no knowledge|nao possuo|nao falo|sem conhecimento)/],
  basic: [/^(basico|basic|elementar|elementary|iniciante|beginner)/],
  intermediate: [/^(intermediario|intermediate)/],
  advanced: [/^(avancado|advanced)/],
  fluent: [/^(fluente|fluent)/],
  native: [/^(nativo|native)/, /^(fluente|fluent)/],
};
const language: Family = ({ L, kind, options, a }) => {
  if (!/(nivel|level|fluencia|fluency|proficien|dominio)/.test(L)) return null;
  const en = /\b(ingles|inglesa|english)\b/.test(L);
  const es = /\b(espanhol|espanhola|spanish|castelhano)\b/.test(L);
  if (en === es) return en ? { fail: "two_languages_in_one_question", source: "languages" } : null;
  const lang = en ? "english" : "spanish";
  if (kind !== "select" && kind !== "radio") return { fail: "language_level_needs_options", source: `languages.${lang}` };
  const opts = options.map((o) => norm(o));
  if (opts.filter((o) => LINKEDIN_SCALE.includes(o)).length >= 3) {
    const v = str(a.languages?.[`${lang}_linkedin_scale`]);
    return v === null ? { fail: `no_bank_value:languages.${lang}_linkedin_scale`, source: `languages.${lang}_linkedin_scale` } : { intent: { t: "text", v }, source: `languages.${lang}_linkedin_scale` };
  }
  if (opts.filter((o) => Object.values(LINKEDIN_SCALE_PT).includes(o)).length >= 3) {
    const source = `languages.${lang}_linkedin_scale`;
    const v = str(a.languages?.[`${lang}_linkedin_scale`]);
    if (v === null) return { fail: `no_bank_value:${source}`, source };
    const pt = LINKEDIN_SCALE_PT[norm(v)];
    return pt ? { intent: { t: "text", v: pt }, source } : { fail: `unknown_value:${source}`, source };
  }
  const level = str(a.languages?.[lang]);
  const res = level ? LEVEL_RES[norm(level)] : undefined;
  if (!res) return { fail: `no_bank_value:languages.${lang}`, source: `languages.${lang}` };
  return {
    intent: {
      t: "pick",
      pick: (o) => {
        for (const re of res) {
          const one = uniqueOption(o, re);
          if (one) return [one];
        }
        return null;
      },
    },
    source: `languages.${lang}`,
  };
};

const salary: Family = (f) => {
  const { L, kind, a, x } = f;
  const desired = /(salario|remuneracao) (desejad|pretendid|esperad)|pretensao salarial|expectativa salarial|desired (salary|compensation|pay)|salary (expectation|rate|requirement)|expected (salary|compensation)/.test(L);
  const current = !desired && /(salario|remuneracao) (atual|ultimo|anterior)|(ultimo|atual) (ou (ultimo|atual) )?salario|current (salary|compensation)|salario atual/.test(L);
  const benefits = !desired && !current && /^(informe )?(seus )?beneficios|current benefits|beneficios atuais/.test(L);
  if (!desired && !current && !benefits) return null;
  if (benefits) return textAt(a, `compensation.current_benefits.text_${langOf(f)}`, { sensitive: true });
  if (current) {
    if (kind === "number") {
      const v = num(a.compensation?.current_salary?.gross_monthly_brl);
      return v === null ? { fail: "no_bank_value:compensation.current_salary.gross_monthly_brl", source: "compensation.current_salary" } : { intent: { t: "num", v }, source: "compensation.current_salary.gross_monthly_brl", sensitive: true };
    }
    return textAt(a, `compensation.current_salary.text_${langOf(f)}`, { sensitive: true });
  }
  // Desired salary: BRL only, and only for a job known to be in Brazil. The field's hint/placeholder count too.
  const H = `${L} ${norm(x.hint)}`;
  if (/\b(usd|us\$|dolar|dollar|eur|euro|€|gbp)\b/.test(H)) return { fail: "non_brl_currency", source: "compensation" };
  if (x.ctx?.country !== "BR") return { fail: x.ctx?.country ? "non_brl_job_country" : "unknown_job_country", source: "compensation" };
  // CLT and PJ amounts differ: a PJ question gets the PJ minimum, never the CLT figure; both named = ask.
  const pj = /\bpj\b|pessoa juridica|contractor|freelance|prestador/.test(H);
  const clt = /\bclt\b/.test(H);
  if (pj && clt) return { fail: "clt_and_pj_in_one_question", source: "compensation" };
  if (pj) {
    const v = num(a.compensation?.desired_pj_monthly?.brazil_brl_min);
    return v === null ? { fail: "no_bank_value:compensation.desired_pj_monthly.brazil_brl_min", source: "compensation" } : { intent: { t: "num", v }, source: "compensation.desired_pj_monthly.brazil_brl_min", sensitive: true };
  }
  const c = a.compensation?.desired_clt_monthly_brl ?? {};
  const path = /\b(minim[oa]|minimum|min)\b/.test(L) ? "min" : /\b(maxim[oa]|maximum|max)\b/.test(L) ? "max" : "single_value";
  const v = num(c[path]);
  return v === null ? { fail: `no_bank_value:compensation.desired_clt_monthly_brl.${path}`, source: "compensation" } : { intent: { t: "num", v }, source: `compensation.desired_clt_monthly_brl.${path}`, sensitive: true };
};

const notice: Family = ({ L, kind, a }) => {
  if (!/aviso previo|notice period|quando (voce )?(pode|poderia) comecar|disponibilidade para inicio|when can you start|start date|data de inicio/.test(L)) return null;
  if (kind === "date") return { fail: "date_fields_not_supported", source: "availability.notice_period_days" };
  const v = num(a.availability?.notice_period_days);
  if (v === null) return { fail: "no_bank_value:availability.notice_period_days", source: "availability.notice_period_days" };
  return { intent: { t: "num", v }, source: "availability.notice_period_days" };
};

const contract: Family = ({ L, a }) => {
  if (!/\bclt\b/.test(L) || /\bpj\b/.test(L)) return null;
  if (!/(aceita|aceitaria|disponivel|disponibilidade|interesse|accept|open to|willing)/.test(L)) return null;
  const types: unknown = a.availability?.contract_types;
  if (!Array.isArray(types)) return { fail: "no_bank_value:availability.contract_types", source: "availability.contract_types" };
  return { intent: { t: "yn", v: types.includes("clt") }, source: "availability.contract_types" };
};

const workAuth: Family = ({ L, a, x }) => {
  if (!/autorizad[oa](\(a\))? (legalmente )?a trabalhar|legally authori[sz]ed|authori[sz]ed to work|eligible to work|work permit|right to work|permissao (legal )?(de|para) trabalh/.test(L)) return null;
  const ac = authCountry(L, x);
  if ("fail" in ac) return { fail: ac.fail, source: "mobility.work_authorized_countries" };
  const c = ac.country;
  const list: unknown = a.mobility?.work_authorized_countries;
  if (!Array.isArray(list)) return { fail: "no_bank_value:mobility.work_authorized_countries", source: "mobility.work_authorized_countries" };
  return { intent: { t: "yn", v: list.includes(c) || ((c === "EU" || EU.has(c)) && list.includes("EU")) }, source: "mobility.work_authorized_countries" };
};

const sponsorship: Family = ({ L, a, x }) => {
  if (!/sponsor|patrocinio|visto de trabalho|work visa|require (a )?visa|precisa(ra|r)? de visto/.test(L)) return null;
  // "Do you NOT require..." flips the meaning: leave that to the user.
  if (/\b(not|nao)\b/.test(L)) return { fail: "negated_question", source: "mobility.needs_visa_sponsorship" };
  const ac = authCountry(L, x);
  if ("fail" in ac) return { fail: ac.fail, source: "mobility.needs_visa_sponsorship" };
  return ynAt(a, `mobility.needs_visa_sponsorship.${regionOf(ac.country)}`);
};

const relocation: Family = ({ L, a }) => {
  if (!/realoca|relocat|mudar(-se)? de cidade|mudanca de cidade|mudar de estado/.test(L)) return null;
  return ynAt(a, "mobility.willing_to_relocate");
};

const WILLING = /(confortavel|disposto|disposta|disponivel|disponibilidade|aceita|aceitaria|trabalharia|atuaria|interesse|comfortable|willing|available|open to|able to|can you|would you work)/;
/** "presencial 3x por semana", "2 dias na semana", "three days a week": part of the week in the office = hybrid. */
const PART_WEEK = /\b([1-4]|um|uma|dois|duas|tres|quatro|one|two|three|four)\s*(x|vezes|dias?|days?|times)\s*(por|na|a|per|each|every)?\s*(semana|week)\b/;
const modality: Family = ({ L, raw, kind, options, a, x }) => {
  const officeWords = /presencial|on-?site|in-office|escritorio|in the office|no local/.test(L);
  const partWeek = officeWords && PART_WEEK.test(L);
  const hybridWord = /hibrid|hybrid/.test(L);
  const hybrid = hybridWord || partWeek;
  const remote = /remot/.test(L);
  // "trabalhar híbrido no escritório regional": the office words only say where the hybrid days are.
  const onsite = officeWords && !partWeek && !hybridWord;
  const n = +hybrid + +remote + +onsite;
  if (!n) return null;
  if (kind === "checkbox_group" && onsite) {
    // Office picker: cities the user accepts, or the single "not interested" option.
    const ok = bool(a.mobility?.accepts_onsite);
    if (ok === null) return { fail: "no_bank_value:mobility.accepts_onsite", source: "mobility.accepts_onsite" };
    if (!ok) {
      const o = uniqueOption(options, /^(nao tenho interesse|nao tenho disponibilidade|not interested|i am not (interested|available)|no,? )/);
      return o ? { intent: { t: "pick", pick: () => [o] }, source: "mobility.accepts_onsite" } : { fail: "no_not_interested_option", source: "mobility.accepts_onsite" };
    }
    const cities: string[] = Array.isArray(a.mobility?.onsite_cities) ? a.mobility.onsite_cities.filter((c: unknown) => typeof c === "string" && c.trim()) : [];
    const hit = realOptions(options).filter((o) => cities.some((c) => hasWord(o, c)));
    return hit.length ? { intent: { t: "pick", pick: () => hit }, source: "mobility.onsite_cities" } : { fail: "no_matching_city", source: "mobility.onsite_cities" };
  }
  if (!WILLING.test(L)) return null;
  if (n > 1) return { fail: "several_modalities_in_one_question", source: "mobility" };
  // "Reside em Exemplópolis ... e tem disponibilidade ...": one Yes/No would also claim where the user lives.
  if (/\b(reside|resides|mora|moras|live|lives|living) (em|no|na|in)\b/.test(L)) return { fail: "residence_in_question", source: "mobility" };
  if (hybrid && bool(a.mobility?.accepts_hybrid) === true) {
    // Hybrid is accepted only inside target.hybrid_area: a "yes" for an office outside it would be wrong, so that stops.
    const area = strs(a.target?.hybrid_area);
    if (area.length && !area.some((c) => hasWord(raw, c) || hasWord(x.ctx?.location ?? "", c))) return { fail: "hybrid_outside_hybrid_area", source: "target.hybrid_area" };
  }
  return ynAt(a, hybrid ? "mobility.accepts_hybrid" : remote ? "mobility.accepts_remote" : "mobility.accepts_onsite");
};

const LEVELS: [RegExp, string][] = [
  [/\bmba\b|master of business administration/, "mba"],
  [/doutorado|\bphd\b|doctorate|doctoral/, "doctorate"],
  [/mestrado|\bmaster/, "master"],
  [/pos-?graduacao|especializacao|postgraduate|post-graduate/, "postgraduate"],
  [/bacharel|licenciatura|bachelor/, "bachelor"],
  [/tecnologo|technologist|associate'?s? degree/, "technologist"],
  [/ensino medio|high school|secondary/, "high_school"],
];
/** Field of study a degree question names ("Bachelor's in Computer Science", "graduação em Administração"), else null. */
export function fieldOfStudy(L: string): string | null {
  const m = L.match(/(?:bachelor'?s?|bacharelado|licenciatura|degree|graduacao|graduado|graduada|formado|formada|formacao|mestrado|master'?s?|doutorado|phd|tecnologo|technologist|curso superior|ensino superior|pos-?graduacao|especializacao|mba|diploma)(?: degree| completo| completa| completed)? (?:in|em|de|of|na|no) ([a-z][a-z /&-]{2,60})/);
  if (!m) return null;
  const f = m[1].replace(/\b(or|ou) (related|similar|equivalent|area|areas|afins|correlat|equivalente).*$/, "").trim();
  if (f === "business administration" && /master of business administration/.test(L)) return null; // the MBA level itself
  if (/^(education|educacao|ensino|study|estudo|escolaridade)\b/.test(f)) return null;
  return f || null;
}

/** A named field of study must match education.degree.course; null-safe fail record otherwise. */
function fieldCheck(L: string, a: Answers): { fail: string; source: string } | null {
  const field = fieldOfStudy(L);
  if (!field) return null;
  const course = str(a.education?.degree?.course);
  if (!course) return { fail: "no_bank_value:education.degree.course", source: "education.degree.course" };
  const ok = loose(course) === loose(field) || hasWord(course, field) || hasWord(field, course);
  return ok ? null : { fail: "field_of_study_not_in_bank", source: "education.degree.course" };
}

const educationLevel: Family = ({ L, a }) => {
  if (!/(completed|concluiu|concluido|concluida|possui|have you|completou).*(level of education|nivel|degree|grau|mba|mestrado|master|doutorado|phd|bacharel|bachelor|tecnologo|pos-?graduacao|ensino medio|high school)/.test(L)) return null;
  const hit = LEVELS.find(([re]) => re.test(L));
  if (!hit) return null;
  const fc = fieldCheck(L, a);
  if (fc) return fc;
  const done: unknown = a.education?.levels_completed;
  if (!Array.isArray(done)) return { fail: "no_bank_value:education.levels_completed", source: "education.levels_completed" };
  const has = done.includes(hit[1]) || (hit[1] === "high_school" && done.length > 0);
  return { intent: { t: "yn", v: has }, source: "education.levels_completed" };
};

const HIGHER_ED: Record<string, RegExp> = {
  technologist_complete: /tecnolog[oa].*complet|complet.*tecnolog|technolog.*complet|associate'?s? degree/,
  bachelor_complete: /(bacharel|licenciatura|bachelor).*complet|complet.*(bacharel|bachelor)/,
  in_progress: /cursando|in progress|incomplet|currently (studying|enrolled)/,
  none: /nao possuo|no degree|^nenhum|^none|nao tenho/,
  postgraduate_complete: /pos-?graduacao.*complet|especializacao.*complet/,
};
const higherEd: Family = (f) => {
  const { L, options, a } = f;
  if (!/curso superior|ensino superior|graduacao|bachelor|degree|formacao academica|escolaridade|nivel de (educacao|escolaridade)|education level/.test(L)) return null;
  if (/level of education:|mba|mestrado|master|doutorado/.test(L)) return null; // a specific level: educationLevel
  const fc = fieldCheck(L, a);
  if (fc) return fc;
  const st = str(a.education?.higher_ed_status);
  if (!st) return { fail: "no_bank_value:education.higher_ed_status", source: "education.higher_ed_status" };
  if (yesNoKind(f)) return { intent: { t: "yn", v: /_complete$/.test(st) }, source: "education.higher_ed_status" };
  const re = HIGHER_ED[st];
  if (!re) return { fail: `unknown_value:education.higher_ed_status`, source: "education.higher_ed_status" };
  const o = uniqueOption(options, re);
  return o ? { intent: { t: "pick", pick: () => [o] }, source: "education.higher_ed_status" } : { fail: "no_matching_option", source: "education.higher_ed_status" };
};

const certifications: Family = ({ L, kind, options, a }) => {
  if (!/certificac(ao|oes)|certificad[oa]s?\b|certification|certificate/.test(L) || /^(eu )?certifico/.test(L)) return null;
  if (kind === "file") return null;
  const certs: unknown = a.education?.certifications;
  if (!Array.isArray(certs)) return { fail: "no_bank_value:education.certifications", source: "education.certifications" };
  const names = certs.map((c) => (typeof c === "string" ? c : c?.name)).filter((n): n is string => typeof n === "string" && !!n.trim());
  if (kind === "checkbox_group" || kind === "select" || kind === "radio") {
    const NONE = /^(nao possu[io]|nenhum|nenhuma|none|nao tenho|no certification)/;
    const hit = realOptions(options).filter((o) => {
      const core = loose(o).replace(/^certificad[oa]s? /, "").replace(/^certification /, "");
      return core.length >= 3 && !NONE.test(norm(o)) && names.some((n) => loose(n) === core || hasWord(n, core));
    });
    if (hit.length) return { intent: { t: "pick", pick: () => hit }, source: "education.certifications" };
    // "None" is only true when the bank lists none; the user having other certifications is not "none".
    if (!names.length) {
      const none = uniqueOption(options, NONE);
      if (none) return { intent: { t: "pick", pick: () => [none] }, source: "education.certifications" };
    }
    return { fail: "no_matching_certification_option", source: "education.certifications" };
  }
  return { fail: "certification_free_text", source: "education.certifications" };
};

const consent: Family = ({ L, a }) => {
  const ai = /(inteligencia artificial|\(ia\)|artificial intelligence|\(ai\)).{0,300}(entrevista|triagem|analis|transcri|screening|interview|selecao|seletivo)|(entrevista|triagem|processo seletivo|screening|interview).{0,300}(inteligencia artificial|\(ia\)|artificial intelligence)/.test(L);
  const privacy = /\blgpd\b|privacidade|privacy|dados pessoais|personal data|tratamento de dados|data protection/.test(L);
  const truth = /^(eu )?(certifico|declaro|i certify|i confirm|i hereby)|veracidade|informacoes .{0,60}(corretas|verdadeiras)|information .{0,60}(true|accurate|correct)/.test(L);
  // A long paragraph can touch several topics: every one of them must be granted.
  const outs = [ai && "consents.ai_screening", privacy && "consents.privacy_lgpd", truth && "consents.truthfulness"].filter(Boolean) as string[];
  if (!outs.length) return null;
  for (const p of outs) {
    // A consent the bank does not grant (false/null) is the user's call: never answered "No" automatically.
    if (bool(get(a, p)) !== true) return { fail: `consent_not_granted:${p}`, source: p };
  }
  return { intent: { t: "yn", v: true }, source: outs.join("+") };
};

const PREFER_NOT = /(prefiro nao|prefer not|i do not wish|i don.?t wish|decline to|nao desejo|nao quero|nao informar|rather not)/;
const diversity: Family = ({ L, kind, options, a }) => {
  const o = options.map(norm);
  const genderOpts = o.some((x) => /^(feminino|female|mulher|woman)/.test(x)) && o.some((x) => /^(masculino|male|homem|man)\b/.test(x));
  const lgbt = /lgbt|orientacao sexual|sexual orientation|identidade de genero|gender identity|transgender|\btrans\b/.test(L);
  const pcd = /pessoa com deficiencia|\bpcd\b|deficiencia|disability|disabled/.test(L);
  const race = /\braca\b|cor (e|ou) raca|cor\/raca|raca\/cor|etnia|etnico|\brace\b|ethnic/.test(L) || o.filter((x) => /^(branca|preta|parda|amarela|indigena|white|black|asian|hispanic)/.test(x)).length >= 2;
  const veteran = /veteran|militar/.test(L);
  const gender = !lgbt && (/\bgenero\b|\bgender\b|\bsexo\b/.test(L) || genderOpts);
  const which = lgbt ? "lgbtqia" : pcd ? "disability_pcd" : race ? "race_ethnicity" : gender ? "gender" : veteran ? "veteran" : null;
  if (!which) return null;
  if (+lgbt + +pcd + +race + +gender > 1) return { fail: "several_diversity_topics", source: "diversity" };
  if (kind !== "select" && kind !== "radio" && kind !== "checkbox_group") return { fail: "diversity_needs_options", source: `diversity.${which}` };
  const v = str(a.diversity?.[which]);
  if (!v) return { fail: `no_bank_value:diversity.${which}`, source: `diversity.${which}` };
  if (v === "prefer_not") {
    const p = uniqueOption(options, PREFER_NOT);
    // Diversity answers are sensitive: gated by the one-time confirmation and masked in logs, even "prefer not".
    return p ? { intent: { t: "pick", pick: () => [p] }, source: `diversity.${which}`, sensitive: true, pii: true } : { fail: "no_prefer_not_option", source: `diversity.${which}` };
  }
  return { intent: { t: "text", v }, source: `diversity.${which}`, sensitive: true, pii: true };
};

const referral: Family = ({ L, options, a }) => {
  if (!/conhece alguem|know (anyone|someone|somebody)|indicacao|indicado por|referral|referred by|foi indicad|relationship with (a |an |any )?(current )?[^?]{0,60}employee|relacionamento (pessoal )?com (algum|alguma|um|uma)? ?(funcionari|colaborador)/.test(L)) return null;
  const d = str(a.referrals?.knows_employee_default);
  if (d !== "none") return { fail: "no_bank_value:referrals.knows_employee_default", source: "referrals.knows_employee_default" };
  const o = uniqueOption(options, /^(nao|no|i do not|i don.?t|nenhum|none|ninguem)\b/);
  if (o) return { intent: { t: "pick", pick: () => [o] }, source: "referrals.knows_employee_default" };
  return { intent: { t: "yn", v: false }, source: "referrals.knows_employee_default" };
};

const currentEmployee: Family = ({ L, a, x }) => {
  if (!/trabalha atualmente (no|na|em|para)|voce e (funcionario|colaborador)|(currently|presently) (work|employed) (at|for|by)|are you a current employee|current employee of/.test(L)) return null;
  const emp = str(a.profile?.current_employer);
  const employed = bool(a.profile?.currently_employed);
  if (!emp) return employed === false ? { intent: { t: "yn", v: false }, source: "profile.currently_employed" } : { fail: "no_bank_value:profile.current_employer", source: "profile.current_employer" };
  const company = x.ctx?.company ?? "";
  const same = hasWord(L, emp) || (!!company && (loose(company) === loose(emp) || hasWord(company, emp) || hasWord(emp, company)));
  return { intent: { t: "yn", v: same }, source: "profile.current_employer" };
};

const CONDITIONAL = /^(se sim|caso (voce )?tenha respondido sim|if (yes|so)\b|if you answered yes)/;
const NA_OPT = /^(na|n\/a|n a|nao se aplica|not applicable|nenhum|none)$/;
const conditional: Family = ({ L, kind, options, a, x }) => {
  if (!x.conditional && !CONDITIONAL.test(L)) return null;
  // NA is only true when the question it follows was answered No.
  if (!x.previousNo) return { fail: "conditional_on_unknown_answer", source: "referrals.conditional_na_text" };
  const na = str(a.referrals?.conditional_na_text);
  if (!na) return { fail: "no_bank_value:referrals.conditional_na_text", source: "referrals.conditional_na_text" };
  if (kind === "checkbox_group" || kind === "select" || kind === "radio") {
    const o = uniqueOption(options, NA_OPT) ?? fuzzyOption(options, na);
    return o ? { intent: { t: "pick", pick: () => [o] }, source: "referrals.conditional_na_text" } : { fail: "no_na_option", source: "referrals.conditional_na_text" };
  }
  return { intent: { t: "text", v: na }, source: "referrals.conditional_na_text" };
};

const heardFrom: Family = ({ L, kind, options, a }) => {
  if (!/como (voce )?(soube|conheceu|ficou sabendo|encontrou)|how did you (hear|find|learn)|onde (voce )?(viu|encontrou) (a|esta) vaga/.test(L)) return null;
  const bankV = str(a.free_text?.heard_from);
  if (kind === "select" || kind === "radio" || kind === "checkbox_group") {
    const o = fuzzyOption(options, bankV ?? "LinkedIn");
    return o ? { intent: { t: "pick", pick: () => [o] }, source: bankV ? "free_text.heard_from" : "fact.applied_via_linkedin" } : { fail: "no_linkedin_option", source: "free_text.heard_from" };
  }
  return { intent: { t: "text", v: bankV ?? "LinkedIn" }, source: bankV ? "free_text.heard_from" : "fact.applied_via_linkedin" };
};

const identity: Family = (f) => {
  const { L, a } = f;
  if (/\bcpf\b/.test(L)) return textAt(a, "profile.cpf", { sensitive: true, pii: true });
  if (/^(linkedin|linkedin profile|linkedin url|perfil (do|no) linkedin|url do linkedin|link do linkedin|seu linkedin|linkedin profile url)$/.test(L)) return textAt(a, "profile.linkedin_url", { pii: true });
  if (/^(github|github url|perfil (do|no) github|link do github)$/.test(L)) return textAt(a, "profile.github_url", { pii: true });
  if (/^(portfolio|portfolio url|website|site|personal website|site pessoal|link do portfolio)$/.test(L)) return textAt(a, "profile.portfolio_url", { pii: true });
  if (/^(empresa atual|current (employer|company)|empregador atual|onde voce trabalha atualmente)$/.test(L)) return textAt(a, "profile.current_employer", { pii: true });
  if (/^(cargo atual|current (title|role|position|job title)|posicao atual)$/.test(L)) return textAt(a, "profile.current_role", { pii: true });
  if (/(which|what) country(\/region)? (are you|do you) (currently )?(based|located|live|reside)|country (of|de) residen|pais (de residencia|onde (voce )?(mora|reside))|em (qual|que) pais (voce )?(mora|reside)/.test(L)) {
    // The country of the bank's own city ("Cidade, São Paulo, Brasil"): never the job's country.
    const c = jobCountry(str(a.profile?.location_city?.pt) ?? str(a.profile?.location_city?.en));
    const names = c ? COUNTRY_NAMES[c] : undefined;
    if (!names) return { fail: "no_bank_value:profile.location_city", source: "profile.location_city" };
    if (TEXT_KINDS.has(f.kind)) return { intent: { t: "text", v: names[langOf(f) === "en" ? 1 : 0] }, source: "profile.location_city", pii: true };
    return { intent: { t: "pick", pick: (o) => { const hit = names.map((n) => fuzzyOption(o, n)).find(Boolean); return hit ? [hit] : null; } }, source: "profile.location_city", pii: true };
  }
  if (/^(cidade|city|location|localizacao|localidade)( \(city\)| atual| de residencia)?$|current location|where (are you|do you) (currently )?(located|live|based)|onde (voce )?(mora|reside)|cidade onde (voce )?mora|em qual cidade (voce )?mora/.test(L)) {
    if (f.kind === "typeahead") return textAt(a, "profile.location_city.typeahead_query", { pii: true });
    return textAt(a, `profile.location_city.${langOf(f)}`, { pii: true });
  }
  return null;
};

const freeText: Family = (f) => {
  const { L, a, kind } = f;
  if (/carta de apresentacao|cover letter/.test(L)) return kind === "file" ? null : { fail: "cover_letter_text_not_in_bank", source: "documents.cover_letter" };
  if (!/por que (voce )?(quer|deseja|gostaria)|why (do you want|are you interested|would you like)|motivacao|fale (um pouco )?sobre voce|tell us about yourself|apresente-se/.test(L)) return null;
  const why = /por que|why|motivacao/.test(L);
  const lang = langOf(f);
  const v = why ? str(a.free_text?.why_company) : str(a.free_text?.pitch_short?.[lang]);
  return v ? { intent: { t: "text", v }, source: why ? "free_text.why_company" : `free_text.pitch_short.${lang}` } : { fail: why ? "no_bank_value:free_text.why_company" : `no_bank_value:free_text.pitch_short.${lang}`, source: "free_text" };
};

const followCompany: Family = ({ L, kind, a }) => {
  if (kind !== "checkbox" || !/^(siga|seguir|follow) /.test(L)) return null;
  return ynAt(a, "documents.follow_company");
};

const FAMILIES: [string, Family][] = [
  ["contact", contact], ["years", skillYears], ["knows", knows], ["language", language], ["salary", salary],
  ["notice", notice], ["contract", contract], ["work_auth", workAuth], ["sponsorship", sponsorship], ["relocation", relocation],
  ["modality", modality], ["education_level", educationLevel], ["higher_ed", higherEd], ["certifications", certifications],
  ["consent", consent], ["diversity", diversity], ["referral", referral], ["current_employee", currentEmployee],
  ["conditional", conditional], ["heard_from", heardFrom], ["identity", identity], ["free_text", freeText], ["follow_company", followCompany],
];

/** Label language from its own words ("pt" | "en"), null when bilingual or unclear. */
export function detectLabelLang(label: string): Lang | null {
  // Labels are short: a plain majority is enough (it only picks text_pt vs text_en).
  const { pt, en } = langScore(label);
  return pt > en ? "pt" : en > pt ? "en" : null;
}

/** norm(label) without the required "*", trailing punctuation, first 400 chars (consent paragraphs are long). */
export const normLabel = (label: string) => norm(label).slice(0, 400).replace(/[\s*?:.]+$/, "").trim();

// --- the resolver --------------------------------------------------------------------------------

const SEMANTIC: Record<string, string> = {
  FIRST_NAME: "profile.first_name",
  LAST_NAME: "profile.last_name",
  PHONE_MOBILE: "profile.phone.national",
  EMAIL: "profile.email",
};

function finish(hit: Hit, kind: FieldKind, options: string[], selected?: string[]): Detailed {
  let value = materialize(hit.intent, kind, options);
  // A long select is truncated in saved maps: the option already selected still counts when it is the bank value.
  if (value === null && hit.intent.t === "text" && (kind === "select" || kind === "radio")) value = fuzzyOption(selected, hit.intent.v);
  // A saved map keeps only the first 15 options of a long select: the answer may be in the part that was cut.
  if (value === null) return { res: null, reason: `${options.some((o) => TRUNCATED.test(o)) ? "option_not_in_truncated_map" : "no_matching_option"}:${hit.source}` };
  const res: Resolution = { value, source: hit.source };
  if (hit.sensitive) res.sensitive = true;
  if (hit.pii) res.pii = true;
  if (hit.policy) res.policy = true;
  return { res };
}

/** resolveAnswer with the reason when it gives nothing (for the needs_answer report). */
export function resolveDetailed(label: string, kind: FieldKind, options: string[] | undefined, answers: Answers | null | undefined, extra: ResolveExtra = {}): Detailed {
  if (!answers) return { res: null, reason: "no_answer_bank" };
  const opts = options ?? [];
  const L = normLabel(label);
  // Options without readable text (mapper "(sem rótulo N)", or the old literal "on"): never clicked by position.
  const unlabeled = (kind === "radio" || kind === "checkbox_group") && (!!extra.unlabeled || (opts.length > 0 && opts.every((o) => /^(on|off)$/i.test(o.trim()))));

  // 1. LinkedIn semantic key.
  if (extra.key === "RESUME" || ((kind === "radio") && /^(resume|curriculo|cv)\b/.test(L))) {
    if (kind !== "radio") return { res: null, reason: "resume_slot_without_radio" };
    if (unlabeled) return { res: null, reason: "unlabeled_options" };
    return pickResume(opts, extra.selected, answers, extra.ctx?.language);
  }
  if (extra.key && SEMANTIC[extra.key]) {
    const out = textAt(answers, SEMANTIC[extra.key], { pii: true });
    if (out && "fail" in out) return { res: null, reason: out.fail };
    return finish(out as Hit, kind, opts, extra.selected);
  }
  if (unlabeled) return { res: null, reason: "unlabeled_options" };

  const args: FamilyArgs = { L, raw: label, kind, options: opts, a: answers, x: extra, labelLang: detectLabelLang(label) };

  // 2. Approved alias (written only on the user's explicit approval).
  // A salary / benefits / diversity / CPF question stays sensitive (confirm_sensitive, masked) even when answered here.
  const sensitiveQuestion = /cpf/.test(L) || salary(args) !== null || diversity(args) !== null;
  const learned: unknown[] = Array.isArray(answers.learned) ? answers.learned : [];
  for (const e of learned as { label_norm?: unknown; kind?: unknown; answer?: unknown }[]) {
    if (!e || typeof e.label_norm !== "string" || normLabel(e.label_norm) !== L) continue;
    if (typeof e.kind === "string" && e.kind !== kind) continue;
    const ans = e.answer;
    let intent: Intent | null = null;
    if (typeof ans === "boolean") intent = { t: "yn", v: ans };
    else if (typeof ans === "number") intent = { t: "num", v: ans };
    else if (typeof ans === "string") intent = { t: "text", v: ans };
    else if (Array.isArray(ans) && ans.every((s) => typeof s === "string")) {
      const want = ans as string[];
      intent = { t: "pick", pick: (o) => { const got = want.map((w) => fuzzyOption(o, w)); return got.every(Boolean) ? (got as string[]) : null; } };
    }
    if (intent) return finish({ intent, source: "learned", ...(sensitiveQuestion ? { sensitive: true, pii: true } : {}) }, kind, opts);
  }

  // 3. Regex families + option fingerprints. Every family that recognises the question answers; they must agree.
  const hits: { name: string; out: Hit | { fail: string; source: string } }[] = [];
  for (const [name, fam] of FAMILIES) {
    const out = fam(args);
    if (out) hits.push({ name, out });
  }
  if (!hits.length) return { res: null, reason: "no_rule" };
  const fails = hits.filter((h) => "fail" in h.out);
  const oks = hits.filter((h) => !("fail" in h.out));
  if (fails.length) {
    const f0 = fails[0].out as { fail: string };
    return { res: null, reason: oks.length ? `conflict:${hits.map((h) => h.name).join(",")}` : f0.fail };
  }
  const done = oks.map((h) => ({ name: h.name, d: finish(h.out as Hit, kind, opts, extra.selected) }));
  const bad = done.find((x) => !x.d.res);
  if (bad) return done.length > 1 ? { res: null, reason: `conflict:${done.map((x) => x.name).join(",")}` } : bad.d;
  const first = done[0].d.res!;
  if (done.some((x) => !sameValue(x.d.res!.value, first.value))) return { res: null, reason: `conflict:${done.map((x) => x.name).join(",")}` };
  if (done.length > 1) {
    first.source = [...new Set(done.map((x) => x.d.res!.source))].join("+");
    if (done.some((x) => x.d.res!.sensitive)) first.sensitive = true;
    if (done.some((x) => x.d.res!.pii)) first.pii = true;
  }
  return { res: first };
}

/**
 * The answer for one question, or null (unknown / ambiguous / bank null => the field is reported
 * unanswered). `options` are the option texts as read from the page.
 */
export function resolveAnswer(label: string, kind: FieldKind, options: string[] | undefined, answers: Answers | null | undefined, extra: ResolveExtra = {}): Resolution | null {
  return resolveDetailed(label, kind, options, answers, extra).res;
}

/** True when an answer means "no / none" (a following "Se sim..." question is then NA). */
export function isNegativeAnswer(v: AnswerValue | undefined): boolean {
  if (v === false) return true;
  if (typeof v === "string") return NO.test(norm(v));
  if (Array.isArray(v)) return v.length === 1 && /^(nao|no|none|nenhum|i do not)\b/.test(norm(v[0]));
  return false;
}
