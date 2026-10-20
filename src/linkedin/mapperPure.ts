/**
 * DOM-free parts of the Easy Apply mapper (types, option labels, PII masking, "why is this
 * form empty"). Kept apart from mapper.ts because that file pulls in the browser session and the
 * database, which tests must never open.
 */
import { clip } from "../guard/untrusted.js";

export type FieldKind =
  | "text" | "number" | "email" | "tel" | "url" | "date" | "textarea" | "select"
  | "radio" | "checkbox" | "checkbox_group" | "typeahead" | "file" | "unknown";

export type MappedField = {
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  selected?: string[];
  prefilled?: string;
  placeholder?: string;
  hint?: string;
  max_length?: number;
  id?: string;
  /** LinkedIn's semantic field key (FIRST_NAME, PHONE_MOBILE, RESUME, custom, ...). */
  key?: string;
  /** Some radio/checkbox options had no readable text: they are named "(sem rótulo N)" in DOM order. */
  unlabeled_options?: boolean;
  /** "Se sim, qual...": only relevant when an earlier answer was yes, so `required` alone must not stop a fill. */
  conditional?: boolean;
};

export type MappedStep = {
  index: number;
  progress: string;
  section: string;
  fields: MappedField[];
  buttons: string[];
  errors: string[];
  /** Visible text of a step that yielded no fields (debugging non-standard flows). */
  dialog_text?: string;
};

/** What the page reports for every radio/checkbox; the label is chosen in Node by pickOptionLabel. */
export type OptSrc = {
  /** <label for=id> text */
  labelFor: string;
  aria: string;
  /** Text of the element right next to the input (not containing another input). */
  sibling: string;
  /** Text of the closest wrapper that holds only this one input. */
  wrapper: string;
  value: string;
  checked: boolean;
  /** The question's own label, so a label[for] that merely repeats it is ignored. */
  groupLabel: string;
};

export type RawField = MappedField & { _opts?: OptSrc[] };
export type RawStep = Omit<MappedStep, "index" | "fields"> & { fields: RawField[] };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Option text for a radio/checkbox: label[for], aria-label, neighbouring text, wrapper text, and only then
 * the value, but never the browser default "on". If nothing is readable it is reported as unlabeled
 * (DOM order), so a fill engine can refuse to guess instead of clicking "on".
 */
export function pickOptionLabel(s: OptSrc, index: number): { text: string; unlabeled: boolean } {
  const group = clean(s.groupLabel).toLowerCase();
  const cands = [s.labelFor, s.aria, s.sibling, s.wrapper].map(clean).filter((t) => t && t.toLowerCase() !== group);
  if (cands.length) return { text: cands[0], unlabeled: false };
  const v = clean(s.value);
  if (v && !/^(on|off)$/i.test(v)) return { text: v, unlabeled: false };
  return { text: `(sem rótulo ${index + 1})`, unlabeled: true };
}

const PLACEHOLDER = /^(selecionar op[cç][aã]o|select an option|selecione|escolha|choose|--+)/i;
const CONDITIONAL = /^\s*(se sim|caso (voc[eê] )?tenha respondido sim|if (yes|so)|if you answered yes)/i;

/** Turns what the page returned into the public step shape (option labels, placeholder -> empty, conditional flag). */
export function finalizeStep(step: RawStep, index: number): MappedStep {
  const fields = step.fields.map(({ _opts, ...f }): MappedField => {
    const out: MappedField = { ...f };
    if (_opts) {
      const picked = _opts.map((o, i) => pickOptionLabel(o, i));
      out.options = picked.map((p) => p.text);
      out.selected = _opts.flatMap((o, i) => (o.checked ? [picked[i].text] : []));
      if (picked.some((p) => p.unlabeled)) out.unlabeled_options = true;
    }
    if (out.selected?.length === 1 && PLACEHOLDER.test(out.selected[0])) out.selected = [];
    if (CONDITIONAL.test(out.label)) out.conditional = true;
    return out;
  });
  return { index, ...step, fields };
}

// --- PII -----------------------------------------------------------------------------------
const EMAIL = /([^\s@<>"']{1,2})[^\s@<>"']*@([^\s@<>"']+\.[^\s@<>"']+)/g;
export const maskEmail = (s: string) => s.replace(EMAIL, (_m, a: string, d: string) => `${a}***@${d}`);
const maskName = (s: string) => (s ? `${s[0]}***` : s);
const maskPhone = (s: string) => `***${s.slice(-4)}`;

const deepStrings = <T>(v: T, f: (s: string) => string): T => {
  if (typeof v === "string") return f(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => deepStrings(x, f)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepStrings(x, f)])) as T;
  return v;
};

/** The account's own name parts and phone numbers, known from the bank and/or the form's own prefills. */
export type Secrets = { names?: (string | null | undefined)[]; phones?: (string | null | undefined)[] };

/** Every string inside `v` (any shape) through textMasker: for dumps that are not form steps (map_page). */
export const maskDeep = <T>(v: T, sec: Secrets): T => deepStrings(v, textMasker(sec));

/** The bank's own name parts and phone numbers (answers.json profile), for masking. */
export function bankSecrets(a: { profile?: Record<string, unknown> } | null | undefined): Secrets {
  const p = (a?.profile ?? {}) as { first_name?: unknown; last_name?: unknown; phone?: { national?: unknown } };
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
  return { names: [s(p.first_name), s(p.last_name)], phones: [s(p.phone?.national)] };
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Masker for free text: e-mails anywhere, every name part as a whole word (case-insensitive), and every known phone
 * number in any formatting ("11900001234", "(11) 90000-1234", "+55 11 9...") down to its last 4 digits.
 */
export function textMasker(sec: Secrets): (s: string) => string {
  const names = [...new Set((sec.names ?? []).flatMap((n) => (n ?? "").split(/\s+/)).map((n) => n.trim()).filter((n) => n.length >= 2))];
  const nameRes = names.map((n) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escRe(n)}(?![\\p{L}\\p{N}])`, "giu"), to: maskName(n) }));
  const phones = [...new Set((sec.phones ?? []).map((p) => (p ?? "").replace(/\D/g, "")).filter((d) => d.length >= 8))];
  // the last 8 digits with optional separators between them, plus an optional "+55 " / "(11) " prefix before them
  const phoneRes = phones.map((d) => ({
    re: new RegExp(`(\\+?\\d{1,3}[\\s.-]*)?(\\(?\\d{2}\\)?[\\s.-]*)?${d.slice(-8).split("").join("[\\s().-]*")}`, "g"),
    to: `***${d.slice(-4)}`,
  }));
  return (s) => {
    let t = maskEmail(s);
    for (const p of phoneRes) t = t.replace(p.re, p.to);
    for (const n of nameRes) t = t.replace(n.re, n.to);
    return t;
  };
}

/**
 * What is saved to <data folder>/form-maps and returned to the LLM must not carry the account's personal data:
 * e-mail addresses anywhere (select options included), and the phone number and first/last name wherever they
 * appear (prefills, but also the review step's free dialog_text, which repeats them). `secrets` adds the bank's
 * own values, so text on a step with no prefilled field is masked too.
 */
export function maskSteps(steps: MappedStep[], secrets: Secrets = {}): MappedStep[] {
  const fields = steps.flatMap((s) => s.fields);
  const isPhone = (f: MappedField) => f.kind === "tel" || f.key === "PHONE_MOBILE";
  const isName = (f: MappedField) => f.key === "FIRST_NAME" || f.key === "LAST_NAME";
  const mask = textMasker({
    names: [...(secrets.names ?? []), ...fields.filter(isName).map((f) => f.prefilled)],
    phones: [...(secrets.phones ?? []), ...fields.filter(isPhone).map((f) => f.prefilled)],
  });
  return steps.map((s) =>
    deepStrings(
      {
        ...s,
        fields: s.fields.map((f) => {
          if (!f.prefilled) return f;
          if (isPhone(f)) return { ...f, prefilled: maskPhone(f.prefilled) };
          if (isName(f)) return { ...f, prefilled: maskName(f.prefilled) };
          return f;
        }),
      },
      // already-masked values ("***1234", "F***") pass through unchanged
      mask,
    ),
  );
}

/** Recruiter-written labels/options are third-party text: clip them. Consent paragraphs run ~1,500 chars, so labels keep 2000. */
export const LABEL_MAX = 2000;
export const OPTION_MAX = 300;
export const clipSteps = (steps: MappedStep[]): MappedStep[] =>
  steps.map((s) => ({
    ...s,
    dialog_text: s.dialog_text === undefined ? undefined : clip(s.dialog_text, 600),
    fields: s.fields.map((f) => ({ ...f, label: clip(f.label, LABEL_MAX), options: f.options?.map((o) => clip(o, OPTION_MAX)) })),
  }));

/** A form that yielded nothing must say why, never return a silent empty list. */
export function emptyReason(stopped: string, steps: MappedStep[], error?: string): string | undefined {
  if (!steps.length) return `The Easy Apply dialog could not be read (stopped: ${stopped}${error ? `; ${error}` : ""}).`;
  if (steps.every((s) => s.fields.length === 0)) {
    const buttons = [...new Set(steps.flatMap((s) => s.buttons))].join(", ") || "none";
    return `No form fields captured in ${steps.length} step(s) (stopped: ${stopped}). Buttons seen: ${buttons}. Probably a non-standard flow (info-only step or embedded form); see dialog_text.`;
  }
  return undefined;
}

/** Why a job page had no Easy Apply button, from its own top card (closed / applied are also saved to the cache). */
export function noEasyApplyError(top: { closed: boolean; applied: boolean }): string {
  if (top.closed) return "Job closed (no longer accepting applications): marked closed in the local cache, so apply_prepare no longer offers it.";
  if (top.applied) return "Already applied to this job: marked applied in the local cache.";
  return "No Easy Apply button (external apply, or the button did not load).";
}
