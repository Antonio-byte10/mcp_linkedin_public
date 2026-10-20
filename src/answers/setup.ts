// Guided setup of <data folder>/answers.json: what is missing (check), creating it from the template (init),
// validated edits (applyUpdates + saveAnswers). Pure logic plus small fs helpers, no browser. Used by the MCP
// tools answers_check / answers_init / answers_set and by the terminal wizard (src/cli/setup-answers.ts).
// Nothing here ever returns a value from the bank: checks and tool results carry paths and labels only.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forgetAnswers, loadAnswers, type Answers } from "./bank.js";

export type FieldKind = "text" | "number" | "bool" | "list" | "choice";
export type Level = "required" | "recommended" | "optional";

export type Field = {
  path: string;
  /** Portuguese question to ask the user. */
  label: string;
  /** Format / example (fake data only). */
  hint?: string;
  kind: FieldKind;
  choices?: string[];
  level: Level;
  sensitive?: true;
  /** Upper bound for kind "number" (default MAX_NUMBER). */
  max?: number;
};

export const MAX_NUMBER = 1_000_000_000;
export const fieldMax = (f: Field) => f.max ?? MAX_NUMBER;

export type FieldInfo = { path: string; label: string; hint?: string; kind: FieldKind; choices?: string[]; sensitive?: true };

export type Check = {
  exists: boolean;
  ready_to_apply: boolean;
  missing: { required: FieldInfo[]; recommended: FieldInfo[] };
  /** count = skills with knows:true; without_years = keys of those with no years. */
  skills: { count: number; without_years: string[] };
  /** Paths still holding a "<...>" template placeholder. */
  placeholders: string[];
  inconsistencies: string[];
};

export type SkillInput = { key: string; aliases?: string[]; years?: number | null; knows?: boolean };
export type Update = { path: string; value: unknown };

// Values the code really accepts: seniority = jobs.ts / match.ts maps, languages.english = LEVEL_RES and
// match.ts, LinkedIn scale = resolver LINKEDIN_SCALE, higher_ed_status = resolver HIGHER_ED keys.
const SENIORITY = ["internship", "entry", "associate", "senior", "director", "executive"];
const MODALITIES = ["remote", "hybrid", "onsite"];
const LEVELS = ["none", "basic", "intermediate", "advanced", "fluent", "native"];
const SCALE = ["None", "Conversational", "Professional", "Native or bilingual"];
const HIGHER_ED = ["technologist_complete", "bachelor_complete", "in_progress", "none", "postgraduate_complete"];
const COMMA = "separe por vírgula";

export const FIELDS: Field[] = [
  // ---- required: apply_execute stops without them ----
  { path: "profile.first_name", label: "Qual é o seu primeiro nome?", kind: "text", level: "required" },
  { path: "profile.last_name", label: "Qual é o seu sobrenome?", kind: "text", level: "required" },
  { path: "profile.email", label: "Qual e-mail você usa nas candidaturas?", hint: "nome@exemplo.com", kind: "text", level: "required" },
  {
    path: "profile.phone.country_option",
    label: "Qual é o país do seu telefone, escrito como o LinkedIn mostra na lista do formulário?",
    hint: 'exatamente como na lista, por exemplo "Brazil (+55)"',
    kind: "text",
    level: "required",
  },
  { path: "profile.phone.national", label: "Qual é o seu telefone (só o número nacional, com DDD)?", hint: "por exemplo: 11912345678", kind: "text", level: "required" },
  {
    path: "profile.location_city.pt",
    label: "Em que cidade você mora? (escreva como em português)",
    hint: "Cidade, Estado, País, por exemplo: Exemplópolis, São Paulo, Brasil",
    kind: "text",
    level: "required",
  },
  {
    path: "profile.location_city.en",
    label: "E a mesma cidade escrita em inglês?",
    hint: "por exemplo: Exemplópolis, Sao Paulo, Brazil",
    kind: "text",
    level: "required",
  },
  {
    path: "profile.location_city.typeahead_query",
    label: "O que digitar no campo de cidade do LinkedIn para a sugestão certa aparecer?",
    hint: "só o nome da cidade, por exemplo: Exemplópolis",
    kind: "text",
    level: "required",
  },
  { path: "profile.total_years_experience", label: "Quantos anos de experiência profissional você tem no total?", hint: "número, por exemplo 3 ou 3,5", kind: "number", level: "required", max: 60 },
  { path: "mobility.accepts_remote", label: "Você aceita trabalhar 100% remoto?", hint: "s/n", kind: "bool", level: "required" },
  { path: "mobility.accepts_hybrid", label: "Você aceita trabalhar em regime híbrido?", hint: "s/n", kind: "bool", level: "required" },
  { path: "mobility.accepts_onsite", label: "Você aceita trabalhar presencialmente?", hint: "s/n", kind: "bool", level: "required" },
  {
    path: "target.include_titles",
    label: "Quais cargos você procura? (palavras que aparecem no título da vaga)",
    hint: `${COMMA}, por exemplo: analista de dados, data analyst`,
    kind: "list",
    level: "required",
  },
  {
    path: "target.seniority",
    label: "Quais níveis de senioridade você procura?",
    hint: `${COMMA} (entry = júnior, associate = pleno, senior = sênior)`,
    kind: "list",
    choices: SENIORITY,
    level: "required",
  },
  { path: "target.modalities", label: "Quais modalidades de trabalho você aceita nas buscas?", hint: COMMA, kind: "list", choices: MODALITIES, level: "required" },
  { path: "languages.english", label: "Qual é o seu nível de inglês?", kind: "choice", choices: LEVELS, level: "required" },
  {
    path: "languages.english_linkedin_scale",
    label: "E o seu inglês na escala do LinkedIn (a usada nos formulários)?",
    hint: "None, Conversational, Professional ou Native or bilingual",
    kind: "choice",
    choices: SCALE,
    level: "required",
  },
  {
    path: "documents.resume_by_language.pt",
    label: "Qual é o nome do arquivo do seu currículo em português, exatamente como está salvo no LinkedIn?",
    hint: "por exemplo: curriculo-pt.pdf",
    kind: "text",
    level: "required",
  },
  {
    path: "documents.resume_by_language.en",
    label: "E o nome do arquivo do currículo em inglês, exatamente como está salvo no LinkedIn?",
    hint: "por exemplo: resume-en.pdf",
    kind: "text",
    level: "required",
  },
  { path: "consents.privacy_lgpd", label: "Você autoriza o envio dos seus dados pessoais às empresas nas candidaturas (LGPD)?", hint: "s/n", kind: "bool", level: "required" },
  { path: "consents.truthfulness", label: "Você declara que as informações enviadas nas candidaturas são verdadeiras?", hint: "s/n", kind: "bool", level: "required" },

  // ---- recommended ----
  { path: "profile.linkedin_url", label: "Qual é o endereço do seu perfil no LinkedIn?", hint: "https://www.linkedin.com/in/seu-perfil", kind: "text", level: "recommended" },
  { path: "profile.current_role", label: "Qual é o seu cargo atual?", kind: "text", level: "recommended" },
  {
    path: "profile.years_in_data",
    label: "Quantos desses anos de experiência são na área de dados?",
    hint: "número, por exemplo 2 ou 2,5; não pode passar do total",
    kind: "number",
    level: "recommended",
    max: 60,
  },
  { path: "profile.currently_employed", label: "Você está empregado(a) hoje?", hint: "s/n", kind: "bool", level: "recommended" },
  {
    path: "target.hybrid_area",
    label: "Em quais cidades ou regiões você aceita vagas híbridas?",
    hint: `${COMMA}, por exemplo: Exemplópolis, Outraville`,
    kind: "list",
    level: "recommended",
  },
  {
    path: "education.higher_ed_status",
    label: "Qual é a situação do seu ensino superior?",
    hint: "technologist_complete (tecnólogo completo), bachelor_complete (bacharelado completo), in_progress (cursando), none (nenhum), postgraduate_complete (pós completa)",
    kind: "choice",
    choices: HIGHER_ED,
    level: "recommended",
  },
  { path: "education.degree.course", label: "Qual é o nome do seu curso superior?", kind: "text", level: "recommended" },
  { path: "education.degree.institution", label: "Em qual instituição você estudou?", kind: "text", level: "recommended" },
  { path: "availability.notice_period_days", label: "Quantos dias de aviso prévio você precisa cumprir?", hint: "0 = disponível já", kind: "number", level: "recommended", max: 365 },
  { path: "free_text.pitch_short.pt", label: "Escreva uma apresentação curta sobre você em português (1 a 3 frases).", kind: "text", level: "recommended" },
  { path: "free_text.pitch_short.en", label: "E a mesma apresentação curta em inglês.", kind: "text", level: "recommended" },

  // ---- optional and sensitive: only if the user wants to ----
  { path: "profile.cpf", label: "Qual é o seu CPF? (só se quiser que as candidaturas o preencham)", hint: "000.000.000-00", kind: "text", level: "optional", sensitive: true },
  { path: "compensation.desired_clt_monthly_brl.min", label: "Pretensão salarial CLT mensal: valor mínimo (R$)?", hint: "número, por exemplo 5000", kind: "number", level: "optional", sensitive: true },
  { path: "compensation.desired_clt_monthly_brl.max", label: "Pretensão salarial CLT mensal: valor máximo (R$)?", hint: "número, por exemplo 7000", kind: "number", level: "optional", sensitive: true },
  {
    path: "compensation.desired_clt_monthly_brl.single_value",
    label: "Pretensão salarial CLT mensal quando o formulário pede um valor só (R$)?",
    hint: "número, por exemplo 6000",
    kind: "number",
    level: "optional",
    sensitive: true,
  },
  { path: "compensation.desired_pj_monthly.brazil_brl_min", label: "Pretensão mínima mensal como PJ no Brasil (R$)?", hint: "número, por exemplo 8000", kind: "number", level: "optional", sensitive: true },
];

const FIELD_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));

export const infoOf = (f: Field): FieldInfo => ({
  path: f.path,
  label: f.label,
  ...(f.hint ? { hint: f.hint } : {}),
  kind: f.kind,
  ...(f.choices ? { choices: [...f.choices] } : {}),
  ...(f.sensitive ? { sensitive: f.sensitive } : {}),
});

// ---- template ---------------------------------------------------------------------------------

export const templatePath = () => path.join(config.root, "docs", "answers.template.json");
const templateText = () => fs.readFileSync(templatePath(), "utf8").replace(/^\uFEFF/, "");
export const loadTemplate = (): Answers => JSON.parse(templateText()) as Answers;

// ---- check ------------------------------------------------------------------------------------

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPlaceholder = (v: unknown) => typeof v === "string" && /^<.*>$/.test(v.trim());
export const getAt = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o);

/** null / undefined / "" / "<...>" / a list with no real item. false and 0 are answers. */
export function isMissing(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return !v.trim() || isPlaceholder(v);
  if (Array.isArray(v)) return !v.some((x) => !isMissing(x));
  return false;
}

/** Number as the resolver reads it: a finite number or a numeric string; otherwise null. */
const numOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;

function findPlaceholders(node: unknown, prefix: string, out: Set<string>): void {
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("_")) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlaceholder(v) || (Array.isArray(v) && v.some(isPlaceholder))) out.add(p);
    else if (isObj(v)) findPlaceholders(v, p, out);
  }
}

export function checkAnswers(bank: Answers | null): Check {
  const missing = { required: [] as FieldInfo[], recommended: [] as FieldInfo[] };
  for (const f of FIELDS) {
    if (f.level === "optional") continue;
    if (!bank || isMissing(getAt(bank, f.path))) missing[f.level].push(infoOf(f));
  }
  if (!bank) return { exists: false, ready_to_apply: false, missing, skills: { count: 0, without_years: [] }, placeholders: [], inconsistencies: [] };

  const skills = (Array.isArray(bank.skills) ? bank.skills : []).filter((s: unknown): s is Record<string, unknown> => isObj(s) && typeof s.key === "string");
  const known = skills.filter((s) => s.knows === true);
  const without_years = known.filter((s) => numOf(s.years) === null).map((s) => s.key as string);

  const inconsistencies: string[] = [];
  const total = numOf(getAt(bank, "profile.total_years_experience"));
  for (const s of skills) {
    const y = numOf(s.years);
    if (total !== null && y !== null && y > total) inconsistencies.push(`skills.${s.key as string}.years is greater than profile.total_years_experience`);
    if (s.knows === false && y !== null && y !== 0) inconsistencies.push(`skills.${s.key as string}: knows is false but years is not 0 or null`);
  }
  const inData = numOf(getAt(bank, "profile.years_in_data"));
  if (total !== null && inData !== null && inData > total) inconsistencies.push("profile.years_in_data is greater than profile.total_years_experience");

  const placeholders = new Set<string>();
  findPlaceholders(bank, "", placeholders);

  return {
    exists: true,
    ready_to_apply: missing.required.length === 0 && known.length > 0 && inconsistencies.length === 0,
    missing,
    skills: { count: known.length, without_years },
    placeholders: [...placeholders],
    inconsistencies,
  };
}

/** What answers_check returns: the check, the file and the next questions to ask (required first, at most 8). */
export function checkReport(file: string) {
  const c = checkAnswers(loadAnswers(file));
  return { file, ...c, next_questions: [...c.missing.required, ...c.missing.recommended].slice(0, 8) };
}

// ---- init -------------------------------------------------------------------------------------

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Creates the bank from the template when absent. Present and not overwrite: nothing changes. Overwrite: the old
 * file is renamed to <name>.backup-YYYYMMDD-HHMMSS.json next to it first, then the template is written.
 */
export function initAnswers(file: string, overwrite = false): { file: string; created: boolean; backup?: string } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = templateText();
  let backup: string | undefined;
  if (overwrite && fs.existsSync(file)) {
    const ext = path.extname(file);
    const base = path.join(path.dirname(file), `${path.basename(file, ext)}.backup-${stamp()}`);
    backup = `${base}${ext}`;
    for (let i = 1; fs.existsSync(backup); i++) backup = `${base}-${i}${ext}`;
    fs.renameSync(file, backup);
  }
  try {
    fs.writeFileSync(file, text, { flag: "wx" }); // wx: never replaces a file that appeared meanwhile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { file, created: false };
    if (!backup) throw e;
    // The old file was already moved aside: put it back when nothing took its place, and say where it is either way.
    let where = `the previous file is saved at ${backup}`;
    try {
      // a partial template left by the failed write (wx created it): remove it, never anything else
      if (fs.existsSync(file) && text.startsWith(fs.readFileSync(file, "utf8"))) fs.rmSync(file, { force: true });
    } catch {
      // the existence check below decides
    }
    if (!fs.existsSync(file)) {
      try {
        fs.renameSync(backup, file);
        where = `the previous file was restored from ${backup}`;
      } catch {
        // keep the message above: the backup is still where it was
      }
    }
    forgetAnswers(file);
    throw new Error(`${(e as Error).message} (${where})`, { cause: e });
  }
  forgetAnswers(file);
  return backup ? { file, created: true, backup } : { file, created: true };
}

// ---- edits ------------------------------------------------------------------------------------

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** sim/não/yes/no (and s/n, true/false) -> boolean, else null. */
export function parseBool(s: string): boolean | null {
  const t = s.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  if (["s", "sim", "y", "yes", "true"].includes(t)) return true;
  if (["n", "nao", "no", "false"].includes(t)) return false;
  return null;
}

/** "3", "3.5", "3,5" -> number (>= 0), else null. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const canonical = (choices: string[], s: string) => choices.find((c) => c.toLowerCase() === s.trim().toLowerCase());
const oneOf = (choices: string[]) => `expected one of: ${choices.join(", ")}`;

function coerceList(field: Field | undefined, value: unknown): (string | number)[] {
  if (!Array.isArray(value)) throw new Error("expected a list (array) of strings or numbers");
  const items: (string | number)[] = [];
  for (const it of value) {
    if (typeof it === "number" && Number.isFinite(it)) {
      if (it < 0) throw new Error("numbers in a list must be >= 0");
      items.push(it);
    }
    else if (typeof it === "string") {
      const t = it.trim();
      if (t) items.push(t);
    } else throw new Error("list items must be strings or numbers");
  }
  if (field?.choices) return items.map((i) => canonical(field.choices as string[], String(i)) ?? (() => { throw new Error(oneOf(field.choices as string[])); })());
  return items;
}

/**
 * A template leaf outside FIELDS holds a number when its template value is a number or its own key name says so:
 * year/years/days/brl/usd as a whole word of the snake_case key (year, total_years_experience, notice_period_days,
 * vr_brl, us_usd_monthly). Anything else (course, institution, text_pt...) is text and is never reinterpreted.
 */
export const isNumberish = (key: string, templateValue: unknown): boolean =>
  typeof templateValue === "number" || /(^|_)(year|years|days|brl|usd)(_|$)/.test(key);

function coerceScalar(field: Field | undefined, value: unknown, numberish = false): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(field ? (field.kind === "text" ? "expected text (a single value, not a list)" : `expected ${field.kind === "number" ? "a number" : "a single value"}`) : "expected a single value (text, number, boolean or null)");
  }
  switch (field?.kind) {
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? parseNumber(value) : null;
      const max = fieldMax(field);
      if (n === null || n < 0 || n > max) throw new Error(`expected a number between 0 and ${max}`);
      return n;
    }
    case "bool": {
      const b = typeof value === "boolean" ? value : typeof value === "string" ? parseBool(value) : null;
      if (b === null) throw new Error("expected true or false (or sim/não, yes/no)");
      return b;
    }
    case "choice": {
      const c = typeof value === "string" ? canonical(field.choices as string[], value) : undefined;
      if (!c) throw new Error(oneOf(field.choices as string[]));
      return c;
    }
    case "text":
      if (typeof value === "boolean") throw new Error("expected text");
      return String(value).trim();
    default:
      if (typeof value === "number" && value < 0) throw new Error("expected a number >= 0 (negative numbers are never accepted)");
      if (numberish && typeof value === "string" && /^-?\d+([.,]\d+)?$/.test(value.trim())) {
        const n = Number(value.trim().replace(",", "."));
        if (n < 0 || n > MAX_NUMBER) throw new Error(`expected a number between 0 and ${MAX_NUMBER}`);
        return n;
      }
      return typeof value === "string" ? value.trim() : (value as number | boolean);
  }
}

const MAX_LEARNED = 200;

/** Paths the form filler uploads from disk: only the user picks them, by hand-editing answers.json (the model never does). */
const UPLOAD_PATHS = new Set(["documents.resume_paths.pt", "documents.resume_paths.en", "documents.cover_letter.file"]);
/** Names that would shadow Object.prototype members if used as a note template key. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Whole learned[] array: only the documented keys are kept (label_norm, kind, answer), with bounded sizes. */
export function coerceLearned(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("learned must be a list of approved answers");
  if (value.length > MAX_LEARNED) throw new Error(`learned takes at most ${MAX_LEARNED} entries`);
  return value.map((e, i) => {
    if (!isObj(e)) throw new Error(`learned[${i}] must be an object { label_norm, kind?, answer }`);
    if (typeof e.label_norm !== "string" || !e.label_norm.trim() || e.label_norm.length > 500) throw new Error(`learned[${i}].label_norm must be non-empty text up to 500 characters`);
    if (e.kind !== undefined && (typeof e.kind !== "string" || e.kind.length > 40)) throw new Error(`learned[${i}].kind must be text up to 40 characters`);
    const a = e.answer;
    const okAnswer =
      (typeof a === "string" && a.length <= 2000) ||
      typeof a === "boolean" ||
      (typeof a === "number" && Number.isFinite(a)) ||
      (Array.isArray(a) && a.length <= 50 && a.every((x) => typeof x === "string" && x.length <= 500));
    if (!okAnswer) throw new Error(`learned[${i}].answer must be text (up to 2000 characters), true/false, a number or a list of texts`);
    return e.kind === undefined ? { label_norm: e.label_norm, answer: a } : { label_norm: e.label_norm, kind: e.kind, answer: a };
  });
}

function setOne(next: Answers, tpl: Answers, p: string, value: unknown): void {
  const segs = p.split(".");
  if (segs.some((s) => !s)) throw new Error("invalid path (empty segment)");
  if (segs.some((s) => s.startsWith("_"))) throw new Error("keys starting with _ are not editable");
  if (UPLOAD_PATHS.has(p)) throw new Error("this is a file path that the application uploads: edite à mão no answers.json (the model never chooses the files to upload)");

  let coerced: unknown;
  if (segs[0] === "note_templates" && segs.length === 2) {
    if (RESERVED_KEYS.has(segs[1]) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(segs[1])) throw new Error("invalid note template name (letters, digits, - and _ only)");
    if (typeof value !== "string") throw new Error("a note template must be text");
    const t = value.trim();
    if (!t) throw new Error("a note template must be non-empty text");
    if (t.length > 300) throw new Error("a note template has at most 300 characters");
    coerced = t;
  } else {
    let node: unknown = tpl;
    for (const s of segs) {
      if (!isObj(node) || !Object.hasOwn(node, s)) throw new Error("unknown path (use the paths from answers_check)");
      node = node[s];
    }
    if (isObj(node)) {
      const kids = Object.keys(node).filter((k) => !k.startsWith("_")).slice(0, 4).map((k) => `${p}.${k}`);
      throw new Error(`this is a section, not a value: set its fields one by one (e.g. ${kids.join(", ")})`);
    }
    if (p === "version" || p === "updated_at") throw new Error("read-only (updated_at is set automatically)");
    if (p === "skills") throw new Error("skills are changed with the skills parameter, not with a path");
    const field = FIELD_BY_PATH.get(p);
    coerced = p === "learned" ? coerceLearned(value) : Array.isArray(node) ? coerceList(field, value) : coerceScalar(field, value, isNumberish(segs[segs.length - 1], node));
  }

  let cur: Record<string, unknown> = next;
  segs.slice(0, -1).forEach((s, i) => {
    const v = cur[s];
    if (v === undefined || v === null) cur[s] = {};
    else if (!isObj(v)) throw new Error(`the bank has a non-object value at ${segs.slice(0, i + 1).join(".")}`);
    cur = cur[s] as Record<string, unknown>;
  });
  cur[segs[segs.length - 1]] = coerced;
}

const keyNorm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/[\s_-]+/g, "_");

/** The key of the bank skill a typed name stands for (its key or one of its aliases, ignoring case, accents and separators), else null. */
export function findSkillKey(bank: Answers, name: string): string | null {
  const want = keyNorm(name);
  const list = Array.isArray(bank.skills) ? (bank.skills as unknown[]) : [];
  for (const s of list) {
    if (!isObj(s) || typeof s.key !== "string") continue;
    const names = [s.key, ...(Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === "string") : [])];
    if (names.some((n) => keyNorm(n) === want)) return s.key;
  }
  return null;
}

function upsertSkill(next: Answers, s: SkillInput): void {
  if (!isObj(s)) throw new Error("a skill must be an object { key, aliases?, years?, knows? }");
  const key = typeof s.key === "string" ? s.key.trim() : "";
  if (!key || key.length > 60) throw new Error("skill key must be 1 to 60 characters");
  if (s.years !== undefined && s.years !== null && !(typeof s.years === "number" && Number.isFinite(s.years) && s.years >= 0 && s.years <= 60)) {
    throw new Error("years must be a number between 0 and 60 (or null)");
  }
  if (s.knows !== undefined && typeof s.knows !== "boolean") throw new Error("knows must be true or false");
  let aliases: string[] | undefined;
  if (s.aliases !== undefined) {
    if (!Array.isArray(s.aliases) || !s.aliases.every((a) => typeof a === "string" && a.trim() && a.trim().length <= 80)) throw new Error("each alias must be non-empty text (up to 80 characters)");
    aliases = [...new Map(s.aliases.map((a) => [a.trim().toLowerCase(), a.trim()])).values()];
  }
  if (next.skills === undefined || next.skills === null) next.skills = [];
  if (!Array.isArray(next.skills)) throw new Error("the bank has a non-list value at skills");
  const list = next.skills as Record<string, unknown>[];
  const existing = list.find((x) => isObj(x) && typeof x.key === "string" && keyNorm(x.key) === keyNorm(key));
  const target: Record<string, unknown> = existing ?? { key, aliases: [key], years: null, knows: null };
  if (aliases) target.aliases = aliases;
  if (s.years !== undefined) target.years = s.years;
  if (s.knows !== undefined) target.knows = s.knows;
  if (target.knows === false) target.years = 0; // "does not know" is 0 years, never a number the form would send
  if (!existing) list.push(target);
}

/**
 * Pure: returns a new bank with the updates applied; throws on the first invalid item and then nothing has been
 * applied (the input is never touched). Error messages name the item and the rule, never the value.
 */
export function applyUpdates(bank: Answers, updates: Update[], skills?: SkillInput[]): Answers {
  const tpl = loadTemplate();
  const next = structuredClone(bank) as Answers;
  updates.forEach((u, i) => {
    const p = isObj(u) && typeof u.path === "string" ? u.path : "";
    try {
      if (!p) throw new Error("each update needs a path (text)");
      setOne(next, tpl, p, (u as Update).value);
    } catch (e) {
      throw new Error(`updates[${i}]${p ? ` (${p.slice(0, 80)})` : ""}: ${(e as Error).message}`);
    }
  });
  (skills ?? []).forEach((s, i) => {
    try {
      upsertSkill(next, s);
    } catch (e) {
      throw new Error(`skills[${i}]: ${(e as Error).message}`);
    }
  });
  next.updated_at = today();
  return next;
}

/** Atomic write (temp file + rename), 2-space JSON and a trailing newline; the loadAnswers cache is dropped. */
export function saveAnswers(file: string, bank: Answers): void {
  const tmp = `${file}.${process.pid}.tmp`; // per process: two servers saving at once never share a temp file
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(bank, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  forgetAnswers(file);
}

export const MAX_SET_ITEMS = 50;

/** answers_set core: load, apply, save. Returns the number of items saved and the new check (no values). */
export function setAnswers(file: string, a: { updates?: Update[]; skills?: SkillInput[] }): { saved: number; check: Check } {
  const updates = a.updates ?? [];
  const skills = a.skills ?? [];
  if (!updates.length && !skills.length) throw new Error("answers_set needs at least one update or skill");
  if (updates.length > MAX_SET_ITEMS || skills.length > MAX_SET_ITEMS) throw new Error(`answers_set takes at most ${MAX_SET_ITEMS} updates and ${MAX_SET_ITEMS} skills per call`);
  const bank = loadAnswers(file);
  if (!bank) throw new Error("NO_ANSWERS: run answers_init first");
  const next = applyUpdates(bank, updates, skills);
  saveAnswers(file, next);
  return { saved: updates.length + skills.length, check: checkAnswers(next) };
}
