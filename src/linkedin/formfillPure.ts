/**
 * DOM-free half of the Easy Apply form filler: turns one step's fields (as the mapper reads them)
 * into a list of actions, decides what is unanswered, and checks the read-back after filling.
 * formfill.ts only executes the plan. Kept apart so the planning is tested offline on the form maps.
 */
import type { Answers } from "../answers/bank.js";
import { detectLanguage, isNegativeAnswer, isPlaceholder, loose, norm, normLabel, resolveDetailed, type AnswerValue, type JobCtx, type Resolution } from "../answers/resolver.js";
import { clip } from "../guard/untrusted.js";
import type { FieldKind, MappedField, MappedStep } from "./mapperPure.js";

/**
 * Job language for the resume choice: only from a real description (a title alone is a guess), so a job
 * that was never enriched gives null and the resume question stays unanswered.
 */
export function jobLanguage(job: { title?: string | null; description?: string | null }) {
  const d = job.description?.trim() ?? "";
  if (d.length < 80) return null;
  return detectLanguage(`${job.title ?? ""}\n${d}`);
}

export type FillCtx = JobCtx & {
  /** The user confirmed sending sensitive data (CPF, salary, benefits) once (policy sensitive_confirmation). */
  allowSensitive?: boolean;
};

/** A field as read for filling: `ref` addresses it in the page (data-mcp-ff stamp). */
export type FillField = MappedField & { ref?: number };

export type PlanAction =
  | { op: "fill"; ref?: number; label: string; kind: FieldKind; value: string }
  | { op: "select"; ref?: number; label: string; kind: FieldKind; value: string }
  /** radio / checkbox_group: exactly these option texts end up checked. */
  | { op: "check"; ref?: number; label: string; kind: FieldKind; value: string[] }
  | { op: "toggle"; ref?: number; label: string; kind: FieldKind; value: boolean }
  /** Type `value`, then pick the suggestion matching one of `targets`. */
  | { op: "typeahead"; ref?: number; label: string; kind: FieldKind; value: string; targets: string[] }
  | { op: "upload"; ref?: number; label: string; kind: FieldKind; value: string };

/** Audit line for the user: label + bank source; values of sensitive/personal keys are masked. */
export type FillLog = {
  step: number;
  label: string;
  kind: FieldKind;
  status: "filled" | "kept" | "left_blank" | "unanswered";
  source?: string;
  value?: string;
  reason?: string;
};

export type Unanswered = { label: string; kind: FieldKind; reason: string; options?: string[] };

export type StepPlan = { ok: boolean; actions: PlanAction[]; unanswered: Unanswered[]; log: FillLog[] };

const LOG_LABEL = 120;
const shortLabel = (f: MappedField) => clip(f.label || "(sem rótulo)", LOG_LABEL);

const CHOICE = new Set<FieldKind>(["select", "radio", "checkbox_group"]);

/** What the field holds now: option texts for choices, "checked" for a checkbox, the text otherwise. */
export function currentValue(f: MappedField): AnswerValue | null {
  if (f.kind === "checkbox") {
    // The mapper's input path reports value "on" (not the checked state); the fill reader reports `selected`.
    if (f.selected) return f.selected.length > 0;
    return null;
  }
  if (CHOICE.has(f.kind)) {
    const s = (f.selected ?? []).filter((x) => !isPlaceholder(x));
    if (!s.length) return null;
    return f.kind === "checkbox_group" ? s : s[0];
  }
  const p = f.prefilled ?? "";
  return p.trim() ? p : null;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Bank value vs what the page holds (tel by digits, text/choices accent-insensitive, groups as sets). */
export function sameAsCurrent(f: MappedField, want: AnswerValue, cur: AnswerValue | null): boolean {
  if (cur === null) return want === false && f.kind === "checkbox";
  if (typeof want === "boolean" || typeof cur === "boolean") return want === cur;
  if (Array.isArray(want) || Array.isArray(cur)) {
    const a = (Array.isArray(want) ? want : [want]).map(loose).sort();
    const b = (Array.isArray(cur) ? cur : [cur]).map(loose).sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (f.kind === "tel" || f.key === "PHONE_MOBILE") return !!digits(want) && digits(cur) === digits(want);
  if (f.kind === "number") return digits(cur) === digits(want) && digits(want) !== "";
  return norm(cur) === norm(want);
}

/** Masked value for the audit log. */
export function logValue(r: Resolution): string | undefined {
  if (r.sensitive || r.pii) return "***";
  if (typeof r.value === "boolean") return r.value ? "checked" : "unchecked";
  return clip(Array.isArray(r.value) ? r.value.join(" | ") : r.value, 120);
}

const RESUME_LABEL = /^(resume|curriculo|cv)\b/;
const TYPEAHEAD_TARGETS = (a: Answers): string[] =>
  [a.profile?.location_city?.pt, a.profile?.location_city?.en].filter((x): x is string => typeof x === "string" && !!x.trim());

/**
 * Plan for one step. Rules: a required field the bank cannot answer -> unanswered (the job stops);
 * an optional one -> left blank (reported). A value LinkedIn prefilled is kept when it equals the bank,
 * overwritten when the bank has an explicit, different entry, and counts as unanswered when only a
 * policy (skills_not_listed) would answer it (audit C3). Sensitive answers need allowSensitive.
 */
export function planStep(fields: FillField[], answers: Answers | null | undefined, ctx: FillCtx = {}, step = 0): StepPlan {
  const actions: PlanAction[] = [];
  const unanswered: Unanswered[] = [];
  const log: FillLog[] = [];
  const hasResumeRadio = fields.some((f) => f.kind === "radio" && (f.key === "RESUME" || RESUME_LABEL.test(norm(f.label))));
  let previousNo = false;

  const stop = (f: FillField, reason: string) => {
    // The resume radio always counts as required: an unresolved one would send LinkedIn's preselected resume.
    const isResumeRadio = f.kind === "radio" && (f.key === "RESUME" || RESUME_LABEL.test(norm(f.label)));
    if (f.required || isResumeRadio) {
      unanswered.push({ label: f.label, kind: f.kind, reason, options: f.options?.slice(0, 20).map((o) => clip(o, 80)) });
      log.push({ step, label: shortLabel(f), kind: f.kind, status: "unanswered", reason });
    } else {
      log.push({ step, label: shortLabel(f), kind: f.kind, status: currentValue(f) === null ? "left_blank" : "kept", reason: `optional:${reason}` });
    }
  };

  for (const f of fields) {
    const base = { ref: f.ref, label: f.label, kind: f.kind };
    const cur = currentValue(f);
    const wasNo = previousNo;
    previousNo = false;

    if (f.kind === "unknown") {
      stop(f, "unknown_field_kind");
      continue;
    }
    if (f.kind === "file") {
      const isResume = RESUME_LABEL.test(norm(f.label)) || f.key === "RESUME";
      if (isResume && hasResumeRadio) {
        log.push({ step, label: shortLabel(f), kind: f.kind, status: "kept", source: "documents.resume_radio" });
        continue;
      }
      if (!f.required) {
        log.push({ step, label: shortLabel(f), kind: f.kind, status: "left_blank", reason: "optional_file" });
        continue;
      }
      const lang = ctx.language === "bilingual" ? answers?.documents?.resume_by_language?.bilingual : ctx.language;
      const p = isResume && (lang === "pt" || lang === "en") ? answers?.documents?.resume_paths?.[lang] : null;
      if (typeof p === "string" && p.trim()) {
        actions.push({ op: "upload", ...base, value: p });
        log.push({ step, label: shortLabel(f), kind: f.kind, status: "filled", source: `documents.resume_paths.${lang}` });
      } else stop(f, isResume ? "no_bank_value:documents.resume_paths" : "required_file_not_in_bank");
      continue;
    }

    const d = resolveDetailed(f.label, f.kind, f.options, answers, {
      key: f.key, ctx, selected: f.selected, conditional: f.conditional, previousNo: wasNo, unlabeled: f.unlabeled_options, max_length: f.max_length,
      hint: [f.hint, f.placeholder].filter(Boolean).join(" "),
    });
    if (!d.res) {
      stop(f, cur !== null ? `prefilled_without_bank_entry (${d.reason})` : d.reason);
      continue;
    }
    const r = d.res;
    previousNo = isNegativeAnswer(r.value);
    if (r.sensitive && !ctx.allowSensitive) {
      stop(f, `sensitive_needs_confirmation:${r.source}`);
      continue;
    }
    if (r.policy && cur !== null) {
      // LinkedIn's prefill (e.g. "Sales: 0 years") is not a bank answer, and a policy is not either.
      stop(f, `prefilled_without_bank_entry (${r.source})`);
      continue;
    }
    const entry = { step, label: shortLabel(f), kind: f.kind, source: r.source, value: logValue(r) };
    // A typeahead's bank value is the query to type, not the answer: only a picked suggestion counts as kept.
    if (f.kind !== "typeahead" && sameAsCurrent(f, r.value, cur)) {
      log.push({ ...entry, status: "kept" });
      continue;
    }
    if (typeof r.value === "string" && f.max_length && r.value.length > f.max_length) {
      stop(f, `answer_longer_than_max_length:${r.source}`);
      continue;
    }
    if (f.kind === "number" && typeof r.value === "string" && !/^\d+([.,]\d+)?$/.test(r.value)) {
      stop(f, `non_numeric_answer:${r.source}`);
      continue;
    }

    const v = r.value;
    if (f.kind === "checkbox" && typeof v === "boolean") actions.push({ op: "toggle", ...base, value: v });
    else if (f.kind === "select" && typeof v === "string") actions.push({ op: "select", ...base, value: v });
    else if (f.kind === "radio" && typeof v === "string") actions.push({ op: "check", ...base, value: [v] });
    else if (f.kind === "checkbox_group" && Array.isArray(v)) actions.push({ op: "check", ...base, value: v });
    else if (f.kind === "typeahead" && typeof v === "string") {
      const targets = TYPEAHEAD_TARGETS(answers ?? {});
      if (!targets.length) {
        stop(f, "no_bank_value:profile.location_city");
        continue;
      }
      // Already holding the city: keep.
      if (typeof cur === "string" && typeaheadHolds(cur, targets)) {
        log.push({ ...entry, status: "kept" });
        continue;
      }
      actions.push({ op: "typeahead", ...base, value: v, targets });
    } else if (typeof v === "string") actions.push({ op: "fill", ...base, value: v });
    else {
      stop(f, `answer_does_not_fit_field:${r.source}`);
      continue;
    }
    log.push({ ...entry, status: "filled", reason: cur !== null && cur !== false ? "overwrote_prefill" : undefined });
  }
  return { ok: unanswered.length === 0, actions, unanswered, log };
}

/**
 * A typeahead input holds the city (same test for the keep check and the read-back): equal, or it contains
 * the target, or it is a complete suggestion ("City, State") contained in the target. A bare typed query
 * ("Cidade") is never "held": it was not picked from the list.
 */
export function typeaheadHolds(cur: string, targets: string[]): boolean {
  const c = loose(cur);
  const complete = cur.split(",").filter((p) => p.trim()).length >= 2;
  return !!c && targets.some((t) => {
    const x = loose(t);
    return !!x && (c === x || c.includes(x) || (complete && x.includes(c)));
  });
}

/**
 * The dialog shows a resume section but no readable resume control (a card or div[role=radio] without an
 * <input>): add a required unknown field so the step stops instead of sending whatever resume is preselected.
 */
export function withUnreadableResume(fields: FillField[], resumeSection: boolean): FillField[] {
  if (!resumeSection) return fields;
  const readable = fields.some((f) => (f.kind === "radio" || f.kind === "file") && (f.key === "RESUME" || RESUME_LABEL.test(norm(f.label))));
  return readable ? fields : [...fields, { label: "Currículo / Resume (unreadable control)", kind: "unknown", required: true }];
}

/** After filling: does the re-read field hold what the action wanted? */
export function verifyAction(a: PlanAction, after: MappedField | undefined): boolean {
  if (!after) return false;
  const cur = currentValue(after);
  switch (a.op) {
    case "fill":
      return sameAsCurrent(after, a.value, cur);
    case "select":
      return typeof cur === "string" && norm(cur) === norm(a.value);
    case "check":
      return sameAsCurrent(after, a.kind === "radio" ? a.value[0] : a.value, cur);
    case "toggle":
      return cur === a.value || (cur === null && a.value === false);
    case "typeahead":
      return typeof cur === "string" && typeaheadHolds(cur, a.targets);
    case "upload":
      return true; // the file chip is checked by the DOM layer
  }
}

/**
 * Typeahead suggestion for the bank city: exact (punctuation-insensitive) match first, then the one
 * suggestion that contains a target or is contained in it, then the one that starts with the typed
 * query. Several candidates at a level -> null (never "the first one").
 */
export function pickTypeaheadOption(suggestions: string[], targets: string[], query?: string): number | null {
  const opts = suggestions.map(loose);
  const ts = targets.map(loose).filter(Boolean);
  const unique = (hits: number[]) => (hits.length === 1 ? hits[0] : hits.length > 1 ? -1 : null);
  const levels = [
    opts.flatMap((o, i) => (ts.includes(o) ? [i] : [])),
    opts.flatMap((o, i) => (o && ts.some((t) => o.includes(t) || t.includes(o)) ? [i] : [])),
    query && loose(query) ? opts.flatMap((o, i) => (o.startsWith(loose(query)) ? [i] : [])) : [],
  ];
  for (const hits of levels) {
    const u = unique(hits);
    if (u === -1) return null;
    if (u !== null) return u;
  }
  return null;
}

/** Dry run over a saved form map: what would be answered, from where, and what is missing. */
export function previewForm(steps: MappedStep[], answers: Answers | null | undefined, ctx: FillCtx = {}) {
  const plans = steps.map((s) => planStep(s.fields, answers, ctx, s.index));
  return {
    ok: plans.every((p) => p.ok),
    answered: plans.flatMap((p) => p.log.filter((l) => l.status === "filled" || l.status === "kept")),
    // label_norm = the key an answers.json "learned" entry must use for this exact question; options as read (≤20).
    unanswered: plans.flatMap((p, i) =>
      p.unanswered.map((u) => ({ step: steps[i].index, label: clip(u.label, 200), label_norm: normLabel(u.label), kind: u.kind, reason: u.reason, options: u.options })),
    ),
  };
}

/** "label — reason" lines for ApplyResult.unanswered. */
export const unansweredLines = (u: Unanswered[]) => u.map((x) => `${clip(x.label || "(sem rótulo)", 160)} — ${x.reason}`);
