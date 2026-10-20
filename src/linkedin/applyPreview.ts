/**
 * Answer preview for apply_prepare: what apply_execute would send for a job, computed offline from the job's
 * saved form map (map_easy_apply_form writes form-maps/<job id>.json in the data folder) and answers.json.
 * Same planner as the real fill (formfillPure.previewForm), so the preview cannot drift from apply_execute.
 * No browser and no database: tests run it on temp folders.
 */
import fs from "node:fs";
import path from "node:path";
import type { Answers } from "../answers/bank.js";
import { jobCountry } from "../answers/resolver.js";
import { clip } from "../guard/untrusted.js";
import { jobLanguage, previewForm, type FillLog } from "./formfillPure.js";
import { maskEmail, type MappedStep } from "./mapperPure.js";

export type FormMap = { mapped_at?: string; stopped?: string; steps: MappedStep[] };

/** Caps per job so a long form never floods the prepare reply. */
const MAX_ANSWERED = 30;
const MAX_UNANSWERED = 15;
const SENSITIVE = /^sensitive_needs_confirmation:/;

/** form-maps/<job id>.json, or null when missing / unreadable / not a map (a broken file never fails prepare). */
export function loadFormMap(dir: string, jobId: string): FormMap | null {
  if (!/^\d{6,12}$/.test(jobId)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.json`), "utf8")) as unknown;
    if (!m || typeof m !== "object" || !Array.isArray((m as FormMap).steps)) return null;
    const steps = (m as FormMap).steps.filter((s) => s && typeof s === "object" && Array.isArray(s.fields));
    return { mapped_at: str((m as FormMap).mapped_at), stopped: str((m as FormMap).stopped), steps };
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The saved map masks the account's own data (maskSteps: e-mail anywhere, phone and name prefills), so an
 * "e-mail" select whose only option is "f***@example.com" would look unanswerable. The live form shows the
 * real values: put back the bank's own value wherever its masked form appears. Only bank values are restored
 * (anything else stays masked), and the preview output masks personal values again (logValue).
 */
export function unmaskWithBank(steps: MappedStep[], a: Answers): MappedStep[] {
  const p = a.profile ?? {};
  const email = typeof p.email === "string" && p.email.includes("@") ? p.email : null;
  const masked = email ? maskEmail(email) : null;
  const restore = (s: string) => (masked && email && s.includes(masked) ? s.split(masked).join(email) : s);
  const phone = typeof p.phone?.national === "string" ? p.phone.national : null;
  const name = (k: unknown) => (typeof k === "string" && k ? k : null);
  return steps.map((s) => ({
    ...s,
    fields: s.fields.map((f) => {
      const g = { ...f, options: f.options?.map(restore), selected: f.selected?.map(restore), prefilled: f.prefilled === undefined ? undefined : restore(f.prefilled) };
      const pre = g.prefilled ?? "";
      const tail = pre.startsWith("***") ? pre.replace(/\D/g, "") : "";
      if (phone && tail && (g.kind === "tel" || g.key === "PHONE_MOBILE") && phone.replace(/\D/g, "").endsWith(tail)) g.prefilled = phone;
      const nm = g.key === "FIRST_NAME" ? name(p.first_name) : g.key === "LAST_NAME" ? name(p.last_name) : null;
      if (nm && /^.\*\*\*$/u.test(pre) && pre[0] === nm[0]) g.prefilled = nm;
      return g;
    }),
  }));
}

const line = (l: FillLog) => ({ step: l.step, label: l.label, ...(l.value !== undefined ? { value: l.value } : {}), source: l.source, ...(l.status === "kept" ? { kept: true } : {}) });

/**
 * Preview for one job. Sensitive answers are planned WITHOUT confirmation (as apply_execute does by default):
 * they come back in needs_confirm_sensitive, so the user sees which questions need confirm_sensitive:true.
 * Values of personal / sensitive bank keys are masked ("***") exactly like the apply transcript.
 */
export function applyPreview(
  job: { title?: string | null; description?: string | null; company?: string | null; location?: string | null },
  answers: Answers | null,
  map: FormMap | null,
) {
  const language = jobLanguage(job);
  if (!answers) return { language, form: "no_answer_bank" as const };
  if (!map) return { language, form: "not_mapped" as const };
  const ctx = { title: job.title, description: job.description, company: job.company, location: job.location, language, country: jobCountry(job.location) };
  const p = previewForm(unmaskWithBank(map.steps, answers), answers, ctx);
  // The resume upload slot next to the saved-resume radio is only bookkeeping: the radio line already says which resume.
  p.answered = p.answered.filter((l) => l.source !== "documents.resume_radio");
  const sensitive = p.unanswered.filter((u) => SENSITIVE.test(u.reason));
  const open = p.unanswered.filter((u) => !SENSITIVE.test(u.reason));
  return {
    language,
    form: {
      mapped_at: map.mapped_at,
      // Only a map that reached the submit step saw every question; otherwise later steps may ask more.
      complete: map.stopped === "submit_step",
      ready: open.length === 0 && map.stopped === "submit_step",
      answered: p.answered.slice(0, MAX_ANSWERED).map(line),
      answered_more: p.answered.length > MAX_ANSWERED ? p.answered.length - MAX_ANSWERED : undefined,
      // label_norm + options let the user approve a "learned" entry in answers.json for exactly this question.
      unanswered: open.length
        ? open.slice(0, MAX_UNANSWERED).map((u) => ({ step: u.step, label: u.label, label_norm: u.label_norm, kind: u.kind, options: u.options?.slice(0, 10), reason: clip(u.reason, 160) }))
        : undefined,
      unanswered_more: open.length > MAX_UNANSWERED ? open.length - MAX_UNANSWERED : undefined,
      needs_confirm_sensitive: sensitive.length ? sensitive.map((u) => u.label) : undefined,
    },
  };
}
