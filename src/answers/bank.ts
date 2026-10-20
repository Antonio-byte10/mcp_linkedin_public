import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Subset of <data folder>/answers.json used by the job filters. The full schema: docs/answers.template.json. */
export type Target = {
  include_titles: string[];
  exclude_titles: string[];
  excluded_companies: string[];
  /** LinkedIn experience levels the user targets: entry / associate / senior / director ... */
  seniority: string[];
  /** remote / hybrid / onsite */
  modalities: string[];
  /** Cities/regions where hybrid is acceptable (matched against the job location). */
  hybrid_area: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Answers = Record<string, any>;

export const answersFile = () => path.join(config.dataDir, "answers.json");

const cache = new Map<string, { mtimeMs: number; size: number; data: Answers }>();

/** "Unexpected token } in JSON at position 120" / "... (line 3 column 5)" -> "line 3, column 5". */
function jsonErrorPlace(text: string, e: Error): string {
  const lc = e.message.match(/line (\d+) column (\d+)/);
  if (lc) return `line ${lc[1]}, column ${lc[2]}`;
  const pos = e.message.match(/position (\d+)/);
  if (pos) {
    const before = text.slice(0, Number(pos[1]));
    const line = before.split("\n").length;
    return `line ${line}, column ${Number(pos[1]) - before.lastIndexOf("\n")}`;
  }
  return "unknown position";
}

/**
 * The one reader of <data folder>/answers.json (jobs filters, analysis, apply). Cached by mtime+size, so a
 * call that needs it three times parses once and an edit is picked up on the next call.
 * Returns null when the file does not exist; throws a clear error when the JSON is invalid.
 */
export function loadAnswers(file: string = answersFile()): Answers | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Position only: the parser's own message can quote a snippet of the file, which holds personal data.
    throw new Error(`answers.json is invalid JSON at ${jsonErrorPlace(text, e as Error)}. Fix ${file} and retry.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`answers.json must contain a JSON object (${file}).`);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: data as Answers });
  return data as Answers;
}

/** Drops the cached parse of `file` (the guided setup calls it after writing, so a same-size edit is never stale). */
export function forgetAnswers(file: string = answersFile()): void {
  cache.delete(file);
}

/** String entries of a list; template placeholders ("<cidade>") are not values. */
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim() && !/^<.*>$/.test(x.trim())) : []);

export function loadTarget(file?: string): Target | null {
  const a = loadAnswers(file);
  if (!a) return null;
  const t = a.target ?? {};
  return {
    include_titles: strs(t.include_titles),
    exclude_titles: strs(t.exclude_titles),
    excluded_companies: strs(t.excluded_companies),
    seniority: strs(t.seniority),
    modalities: strs(t.modalities),
    hybrid_area: strs(t.hybrid_area),
  };
}

/** answers.json "note_templates": { key: text }; only non-empty string values (see linkedin/noteTemplate.ts for the syntax). */
export function loadNoteTemplates(file?: string): Record<string, string> {
  const nt = loadAnswers(file)?.note_templates;
  if (!nt || typeof nt !== "object" || Array.isArray(nt)) return {};
  return Object.fromEntries(Object.entries(nt).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim()]));
}

const SENIOR_TITLE = /\b(s[eê]nior|sr|especialista|specialist|lead|l[ií]der|coordenador[a]?|gerente|head|manager|principal|staff|diretor[a]?|director)\b/i;

/**
 * Modality from the "(Remoto|Híbrido|Presencial)" suffix of the location, and seniority from the title.
 * Unknown modality passes (it gets checked again on the job page).
 */
export function fitsPreferences(title: string | null, location: string | null, t: Target | null): boolean {
  if (!t) return true;
  // Accent-folded first: page text can arrive decomposed (NFD "Híbrido"), which a literal "Híbrido" misses.
  const nl = norm(location);
  if (t.modalities.length) {
    if (/\((presencial|on-site|onsite)\)/.test(nl) && !t.modalities.includes("onsite")) return false;
    if (/\((hibrido|hybrid)\)/.test(nl)) {
      if (!t.modalities.includes("hybrid")) return false;
      // Whole-word: "SP" must not match inside "Espírito Santo" / "Campinas".
      if (t.hybrid_area.length && !t.hybrid_area.some((a) => hasWord(nl, a))) return false;
    }
  }
  if (t.seniority.length && !t.seniority.some((s) => ["senior", "director", "executive"].includes(s)) && SENIOR_TITLE.test(title ?? "")) return false;
  return true;
}

/**
 * Apply-time re-check (audit I10) against what the job page's own top card shows now: its location and its
 * modality pill ("Híbrido") become the "Location (Modality)" form fitsPreferences reads. Cached values fill gaps.
 */
export function fitsJobPage(
  top: { title?: string; location?: string; modality?: string },
  cached: { title: string | null; location: string | null },
  t: Target | null,
): boolean {
  const loc = top.location?.trim() || cached.location || "";
  const withModality = top.modality?.trim() && !/\(.*\)\s*$/.test(loc) ? `${loc} (${top.modality.trim()})` : loc;
  return fitsPreferences(top.title?.trim() || cached.title, withModality, t);
}

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const wordRe = new Map<string, RegExp>();
/** Whole-word match so "bi" doesn't hit "bilingual" and "data" doesn't hit "update". `hay` must already be norm()ed. */
const hasWord = (hay: string, k: string) => {
  let re = wordRe.get(k);
  if (!re) {
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${norm(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
    wordRe.set(k, re);
  }
  return re.test(hay);
};

export function isExcludedCompany(company: string | null, t: Target | null): boolean {
  const c = norm(company);
  return !!t && !!c && t.excluded_companies.some((x) => c.includes(norm(x)));
}

/** Inside the user's target area: title hits include_titles (if any) and none of exclude_titles. */
export function inTargetArea(title: string | null, t: Target | null): boolean {
  if (!t) return true;
  const h = norm(title);
  if (t.exclude_titles.some((k) => hasWord(h, k))) return false;
  return !t.include_titles.length || t.include_titles.some((k) => hasWord(h, k));
}
