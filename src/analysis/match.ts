import { loadAnswers } from "../answers/bank.js";
import type { JobRow } from "../store/db.js";
import { analyzeSkills, norm, SKILLS, skillsInText, SPOKEN } from "./skills.js";

export type Seniority = "Estágio" | "Trainee" | "Júnior" | "Pleno" | "Sênior" | "Especialista" | "Liderança" | "Não informado";
/** Pendente = only the title is known (run jobs_enrich): not enough text to judge skills. */
export type MatchLevel = "Alto" | "Médio" | "Baixo" | "Pendente";

/**
 * Jobs apply_prepare may offer: really analysed and a fit. Pendente (title only) is never offered: without a
 * description the resume language and the requirements are guesses (run jobs_enrich first); Baixo never.
 */
export const offerableForApply = (level: MatchLevel | string) => level === "Alto" || level === "Médio";

/**
 * The poster's "Requisitos" bullets stored as a JSON array. Malformed JSON, a non-array or
 * non-string items never throw: they are dropped (one bad row must not abort a whole export).
 */
export function safeReqs(j: { requirements?: string | null }): string[] {
  if (!j.requirements) return [];
  try {
    const v: unknown = JSON.parse(j.requirements);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const LEVEL_ORDER: Seniority[] = ["Júnior", "Pleno", "Sênior"];
/** Roles that say "manager" but are not people-leadership: Product Manager, Account Manager, Gerente de Contas ... */
const NOT_LEADERSHIP = /\b(?:product|account|project|program|customer success|community|social media|relationship|key account) manager\b|\bgerente de (?:contas?|projetos?|produtos?|relacionamento)\b/g;

/** Title first (most reliable), then description wording. */
export function inferSeniority(title: string | null, description: string | null): Seniority {
  const t = norm(title).replace(NOT_LEADERSHIP, " ");
  const early: [RegExp, Seniority][] = [
    [/\b(estagio|estagiari[oa]|intern|internship)\b/, "Estágio"],
    [/\btrainee\b/, "Trainee"],
    [/\b(head|gerente|manager|coordenador[a]?|coordinator|lider|director|diretor[a]?|supervisor[a]?)\b|\blead\b(?!\s*(?:gen|generation|scoring|qualification))/, "Liderança"],
    [/\b(especialista|specialist|principal|staff)\b/, "Especialista"],
  ];
  for (const [re, s] of early) if (re.test(t)) return s;
  // Ranges ("Júnior/Pleno", "Pleno/Sênior") resolve to the LOWER level.
  const levels: [RegExp, Seniority][] = [
    [/\b(junior|jr\.?|entry)\b|(?:^|\s)i\s*(?:$|[(,|/])/, "Júnior"],
    [/\b(pleno|pl|mid|middle)\b|(?:^|\s)ii\s*(?:$|[(,|/])/, "Pleno"],
    [/\b(senior|sr\.?)\b|(?:^|\s)iii\s*(?:$|[(,|/])/, "Sênior"],
  ];
  const found = levels.filter(([re]) => re.test(t)).map(([, s]) => s);
  if (found.length) return found.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))[0];
  const d = norm(description);
  if (/\b(vaga|posicao|nivel|perfil)\s+(junior|jr)\b|\bjunior level\b/.test(d)) return "Júnior";
  if (/\b(vaga|posicao|nivel|perfil)\s+pleno\b|\bmid[- ]level\b|\bmid level\b/.test(d)) return "Pleno";
  if (/\b(vaga|posicao|nivel|perfil)\s+(senior|sr)\b|\bsenior level\b/.test(d)) return "Sênior";
  // Weak signal, only because the title was silent: "3+ anos de experiência", "5 years of experience".
  const y = d.match(/(\d{1,2})\s*\+?\s*(?:anos|years?)(?:\s+(?:de|of))?\s+(?:de\s+)?(?:experiencia|experience)/);
  if (y) {
    const n = Number(y[1]);
    return n <= 2 ? "Júnior" : n <= 4 ? "Pleno" : "Sênior";
  }
  return "Não informado";
}

/** Rough area from the title. */
export function inferArea(title: string | null): string {
  const t = norm(title);
  const rules: [RegExp, string][] = [
    [/\b(engenheir[oa] de dados|data engineer|engenharia de dados|analytics engineer|etl)\b/, "Engenharia de Dados"],
    [/\b(cientista de dados|data scientist|ciencia de dados|machine learning|ml engineer|ia|ai)\b/, "Ciência de Dados / IA"],
    [/\b(bi|business intelligence|power bi|analytics|dados|data|insights)\b/, "Análise de Dados / BI"],
    [/\b(desenvolvedor|developer|software|frontend|backend|full ?stack|programador)\b/, "Desenvolvimento"],
    [/\b(produto|product)\b/, "Produto"],
    [/\b(financeir[oa]|finance|controladoria|contabil)\b/, "Finanças"],
    [/\b(marketing|growth|crm)\b/, "Marketing / Growth"],
    [/\b(operac|operations|logistic|supply)\w*/, "Operações / Logística"],
    [/\b(rh|recursos humanos|human resources|hr|people|recrutamento|recruiter|recruiting|talent|departamento pessoal)\b/, "RH / People"],
    [/\b(pricing|precificacao)\b/, "Pricing"],
    [/\b(vendas|sales|comercial|sdr|bdr|customer success)\b/, "Vendas / Comercial"],
    [/\b(juridic[oa]|legal|advogad[oa]|compliance)\b/, "Jurídico"],
    [/\b(ti|suporte|support|help ?desk|service desk|infraestrutura|sysadmin|devops|redes)\b/, "TI / Suporte"],
  ];
  for (const [re, a] of rules) if (re.test(t)) return a;
  return "Outros";
}

/** User's own skills that have no dictionary entry: their aliases are matched directly against the job text. */
export type UserSkills = Set<string> & { extra?: Record<string, string[]> };

const titleCase = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** User's skills from <data folder>/answers.json mapped onto the canonical dictionary (plus extras the dictionary lacks). */
export function loadUserSkills(file?: string): UserSkills {
  const out: UserSkills = new Set<string>();
  const a = loadAnswers(file);
  if (!a) return out;
  const extra: Record<string, string[]> = {};
  for (const s of (a.skills ?? []) as { key?: string; aliases?: string[]; knows?: boolean }[]) {
    if (!s || typeof s.key !== "string" || s.knows === false) continue;
    const aliases = [s.key.replace(/_/g, " "), ...(Array.isArray(s.aliases) ? s.aliases.filter((x) => typeof x === "string") : [])];
    let mapped = false;
    for (const al of aliases) for (const k of skillsInText(al)) (out.add(k), (mapped = true));
    if (!mapped) {
      extra[titleCase(s.key)] = aliases;
      out.add(titleCase(s.key));
    }
  }
  if (Object.keys(extra).length) out.extra = extra;
  // Spoken languages count as a skill only at a working level.
  if (["advanced", "fluent", "native"].includes(a.languages?.english)) out.add("Inglês");
  if (["advanced", "fluent", "native"].includes(a.languages?.spanish)) out.add("Espanhol");
  return out;
}

/** Seniority levels the user targets (answers.json target.seniority: entry/associate/...). */
export function loadTargetSeniority(file?: string): Set<Seniority> {
  const map: Record<string, Seniority[]> = {
    internship: ["Estágio"], entry: ["Júnior", "Trainee"], associate: ["Pleno"], senior: ["Sênior", "Especialista"], director: ["Liderança"],
  };
  const want = loadAnswers(file)?.target?.seniority;
  return new Set((Array.isArray(want) ? (want as string[]) : []).flatMap((w) => map[w] ?? []));
}

export type JobAnalysis = {
  area: string;
  seniority: Seniority;
  seniority_fit: "Sim" | "Parcial" | "Não";
  /** Technical skills the job asks for (required + nice-to-have), spoken languages excluded. */
  skills_job: string[];
  skills_have: string[];
  skills_missing: string[];
  /** Subset of skills_job that is only nice-to-have (counts at half weight). */
  skills_nice: string[];
  /** Spoken languages the job requires (not nice-to-have), kept out of the coverage. */
  languages_job: string[];
  languages_missing: string[];
  /** true when every required spoken language is at a working level for you. */
  language_ok: boolean;
  skill_coverage: number; // 0-1, weighted: required 1, nice-to-have 0.5
  /** null while Pendente (title only): nothing to score. */
  match_score: number | null; // 0-100
  match_level: MatchLevel;
  analyzed_from: "Descrição completa" | "Só título";
};

/**
 * 3-level match:
 *  - Alto:  seniority fits AND you have >= 60% of the skills the job mentions (min. 3 found)
 *  - Médio: seniority fits or is partial/unknown AND coverage >= 35%
 *  - Baixo: everything else (incl. Sênior/Especialista/Liderança when you target Júnior/Pleno)
 *  - Pendente: no description/requirements stored yet (title only), so skills can't be judged
 * Score = 70% skill coverage + 30% seniority fit (capped at 35 when seniority doesn't fit).
 * Skills the ad says are NOT needed are dropped; "diferencial/desejável" ones count half.
 */
export function analyzeJob(j: JobRow, userSkills: Set<string>, target: Set<Seniority>): JobAnalysis {
  const reqs = safeReqs(j);
  const text = `${j.title ?? ""} \n ${j.description ?? ""} \n ${reqs.join(" \n ")}`;
  const sk = analyzeSkills(text, (userSkills as UserSkills).extra);
  const tech = (l: string[]) => l.filter((s) => !SPOKEN.has(s));
  const required = tech(sk.required);
  const nice = tech(sk.nice);
  const skills_job = [...Object.keys(SKILLS), ...Object.keys((userSkills as UserSkills).extra ?? {})].filter((k) => required.includes(k) || nice.includes(k));
  const skills_have = skills_job.filter((s) => userSkills.has(s));
  const skills_missing = skills_job.filter((s) => !userSkills.has(s));
  const w = (s: string) => (nice.includes(s) && !required.includes(s) ? 0.5 : 1);
  const total = skills_job.reduce((n, s) => n + w(s), 0);
  const have = skills_have.reduce((n, s) => n + w(s), 0);
  const coverage = total ? have / total : 0;
  const languages_job = sk.required.filter((s) => SPOKEN.has(s));
  const languages_missing = languages_job.filter((s) => !userSkills.has(s));
  const seniority = inferSeniority(j.title, j.description);
  const fit: JobAnalysis["seniority_fit"] = !target.size
    ? "Parcial"
    : target.has(seniority)
      ? "Sim"
      : seniority === "Não informado" || seniority === "Trainee"
        ? "Parcial"
        : "Não"; // Estágio is "Não" unless the target includes internships (then target.has() above)
  const fitScore = fit === "Sim" ? 1 : fit === "Parcial" ? 0.5 : 0;
  const rawScore = Math.round(100 * (0.7 * coverage + 0.3 * fitScore));
  const hasText = (j.description?.trim().length ?? 0) > 80 || reqs.length > 0;
  const level: MatchLevel = !hasText
    ? fit === "Não" ? "Baixo" : "Pendente"
    : fit === "Sim" && coverage >= 0.6 && skills_job.length >= 3 ? "Alto" : fit !== "Não" && coverage >= 0.35 ? "Médio" : "Baixo";
  return {
    area: inferArea(j.title),
    seniority,
    seniority_fit: fit,
    skills_job,
    skills_have,
    skills_missing,
    skills_nice: skills_job.filter((s) => nice.includes(s) && !required.includes(s)),
    languages_job,
    languages_missing,
    language_ok: languages_missing.length === 0,
    skill_coverage: Math.round(coverage * 100) / 100,
    match_score: level === "Pendente" ? null : fit === "Não" ? Math.min(rawScore, 35) : rawScore,
    match_level: level,
    analyzed_from: hasText ? "Descrição completa" : "Só título",
  };
}

export const ALL_SKILLS = Object.keys(SKILLS);
