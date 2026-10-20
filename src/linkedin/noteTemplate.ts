/**
 * Connection-note templates (answers.json "note_templates"). Pure: no browser, no db.
 *
 * Placeholders: {first_name} {company} {role}. The values come from the cached LinkedIn person
 * (third-party text), so they are stripped of invisible characters and of brackets/braces; the
 * template text itself is the user's own.
 *
 * Optional-fragment rule: a part written as [ ... ] is kept only when every placeholder inside it
 * can be filled, otherwise the whole part is dropped. Outside brackets, a sentence (up to . ! ? or a
 * newline) containing an unfillable {company}/{role} (or an unknown {placeholder}) is dropped. No
 * first name means no note at all (the caller rejects the candidate). The output never holds
 * a literal {...} or [ ].
 */
import { looksLikeCompany } from "../analysis/skills.js";
import { clip } from "../guard/untrusted.js";
import { NOTE_MAX } from "./writeRules.js";

export type NoteVars = { first_name?: string; company?: string; role?: string };
export type NoteResult = { ok: true; note: string } | { ok: false; reason: string };

const cleanVal = (s: string | null | undefined) => clip(s, 120).replace(/[{}[\]]/g, "").replace(/\s+/g, " ").trim();

/** First word of the cached name, if it holds a letter ("Dr." counts; "-" or "" does not). */
export function firstNameOf(name: string | null | undefined): string {
  const w = cleanVal(name).split(" ")[0] ?? "";
  return /\p{L}/u.test(w) ? w : "";
}

// Candidates must pass looksLikeCompany (upper-case/digit start, not a skill): keeps "Especialista em dados" from
// yielding "dados" and "Analista de Dados | Python" from yielding "...na Python".
const cutCompany = (s: string) => s.split(/\s+[|·•–—-]\s+|\s*[,(|]\s*/)[0].trim();

/** { role, company } from "Role at Company", "Role na/no/em Company", "Role | Company", "Role @ Company"; empty strings when unparseable. */
export function parseHeadline(headline: string | null | undefined): { role: string; company: string } {
  const h = cleanVal(headline);
  const none = { role: "", company: "" };
  if (!h) return none;
  const bar = h.split(/\s+\|\s+/);
  // "A | B" is Role | Company; with 3+ parts the tail is usually skills, so only look inside each part.
  if (bar.length === 2 && !/\s(at|na|no|em|@)\s/i.test(h)) {
    const company = cutCompany(bar[1]);
    return looksLikeCompany(company) ? { role: bar[0].trim(), company } : none;
  }
  for (const part of bar) {
    const m = part.match(/^(.+?)\s+(?:at|na|no|em|@)\s+(.+)$/i) ?? part.match(/^(.+?)\s*@\s*(.+)$/);
    if (!m) continue;
    const company = cutCompany(m[2]);
    if (company && looksLikeCompany(company)) return { role: m[1].trim(), company };
  }
  return none;
}

const PH = /\{([a-z_]+)\}/gi;
const KNOWN = new Set(["first_name", "company", "role"]);

/** Fills a fragment; null when any placeholder in it has no value. */
function fill(text: string, v: Record<string, string>): string | null {
  let missing = false;
  const out = text.replace(PH, (_m, k: string) => {
    const val = KNOWN.has(k.toLowerCase()) ? v[k.toLowerCase()] : "";
    if (!val) missing = true;
    return val ?? "";
  });
  return missing ? null : out;
}

export function renderNote(template: string, vars: NoteVars): NoteResult {
  const v = { first_name: cleanVal(vars.first_name), company: cleanVal(vars.company), role: cleanVal(vars.role) };
  if (/\{first_name\}/i.test(template) && !v.first_name) return { ok: false, reason: "no first name available for {first_name}" };
  // 1) optional [ ... ] parts; a stray bracket is removed afterwards.
  const opt = template.replace(/\[([^[\]]*)\]/g, (_m, inner: string) => fill(inner, v) ?? "");
  // 2) sentences outside brackets: drop the ones that cannot be filled.
  const parts = opt.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [];
  const text = parts.map((p) => fill(p, v) ?? "").join("");
  const note = text
    .replace(/[[\]{}]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (!note) return { ok: false, reason: "template renders empty (all fragments need data this profile lacks)" };
  if (note.length > NOTE_MAX) return { ok: false, reason: `rendered note is ${note.length} chars (max ${NOTE_MAX})` };
  return { ok: true, note };
}

/**
 * connect_execute gating, pure so it is unit-tested: which note each id may be sent with.
 * With note_template, only the note stored in the batch meta at connect_prepare (what the user
 * previewed) is ever returned; a batch prepared without that key, or lacking an id, throws.
 * Without it, the caller's own note (trimmed) applies to every id.
 */
export function connectNotePlan(
  meta: Record<string, unknown> | undefined,
  args: { note?: string; note_template?: string },
  ids: string[],
): (id: string) => string | undefined {
  if (args.note && args.note_template) throw new Error("Pass either note or note_template, not both.");
  if (!args.note_template) {
    const note = args.note?.trim() || undefined;
    return () => note;
  }
  const stored = (meta?.notes ?? {}) as Record<string, string>;
  // own keys only: an inherited name ("constructor") must never count as a stored note
  const has = (i: string) => Object.hasOwn(stored, i) && typeof stored[i] === "string" && !!stored[i];
  if (meta?.note_template !== args.note_template || ids.some((i) => !has(i))) {
    throw new Error(`This batch was not prepared with note_template "${clip(args.note_template, 60)}". Run connect_prepare again with that note_template and use its note_preview.`);
  }
  return (id) => stored[id];
}
