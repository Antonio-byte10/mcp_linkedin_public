import type { Locator, Page } from "playwright-core";
import { jitter, pause } from "../browser/humanize.js";
import { answersFile, loadAnswers, type Answers } from "../answers/bank.js";
import { jobCountry, loose, norm } from "../answers/resolver.js";
import type { FillStep } from "./apply.js";
import { easyApplyDialog } from "./mapper.js";
import { readEasyApplyDialog } from "./dialog.js";
import { finalizeStep } from "./mapperPure.js";
import { jobLanguage, pickTypeaheadOption, withUnreadableResume, planStep, unansweredLines, verifyAction, type FillCtx, type FillField, type FillLog, type PlanAction } from "./formfillPure.js";
import { APPLY_DIALOG_TITLE_RE } from "./writeRules.js";

/**
 * Easy Apply form filler (answer bank). For each step: read the dialog's fields (the same shared reader the
 * mapper uses, dialog.ts), plan with the pure planner, and only when EVERY required field has a bank answer
 * fill them, then re-read and verify each value. It never clicks Next/Submit (apply.ts does that after
 * this returns ok) and never touches anything outside the Easy Apply dialog: every control is addressed
 * through a data-mcp-ff stamp set inside the dialog by the reader.
 */

/** Runs the shared dialog reader in fill mode (stamps each field and option input for later addressing). */
async function readRaw(page: Page) {
  return page.evaluate(readEasyApplyDialog, { titleRe: APPLY_DIALOG_TITLE_RE.source, opts: { fill: true } }).catch(() => null);
}

/** Reads the dialog's current fields (labels/options through the mapper's pure finalizeStep). */
async function readFields(page: Page, stepIndex: number): Promise<FillField[] | null> {
  const raw = await readRaw(page);
  if (!raw) return null;
  const step = finalizeStep({ progress: "", section: "", buttons: [], errors: [], fields: raw.fields }, stepIndex);
  // finalizeStep maps fields 1:1, so index i is the same control; a field without a ref is never acted on (act()).
  return withUnreadableResume(step.fields.map((f, i): FillField => ({ ...f, ref: raw.fields[i].ref })), raw.resumeSection);
}


/** Clicks an option the way a person does: its <label for>, else the input itself. */
async function clickOption(dlg: Locator, input: Locator) {
  const id = await input.getAttribute("id");
  const label = id ? dlg.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first() : null;
  if (label && (await label.count())) await label.click({ timeout: 5000 });
  else await input.click({ timeout: 5000, force: true });
}

async function typeInto(loc: Locator, value: string) {
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => null);
  await loc.click({ timeout: 5000 });
  await loc.fill("");
  // Short answers are typed like a person; long ones (benefits text) are pasted.
  if (value.length <= 40) await loc.pressSequentially(value, { delay: jitter(40, 110) });
  else await loc.fill(value);
  await loc.dispatchEvent("input");
  await loc.dispatchEvent("change");
  await loc.blur().catch(() => null);
}

/** Executes one planned action inside the dialog. Returns false when it could not be applied. */
async function act(page: Page, dlg: Locator, a: PlanAction, field: FillField | undefined): Promise<boolean> {
  const loc = dlg.locator(`[data-mcp-ff="${a.ref}"]`).first();
  if (a.ref === undefined || !(await loc.count())) return false;
  switch (a.op) {
    case "fill": {
      await typeInto(loc, a.value);
      const v = await loc.inputValue({ timeout: 3000 }).catch(() => null);
      return v !== null && (a.kind === "tel" || a.kind === "number" ? v.replace(/\D/g, "") === a.value.replace(/\D/g, "") : norm(v) === norm(a.value));
    }
    case "select": {
      const labels = (await loc.locator("option").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
      const idx = labels.flatMap((t, i) => (norm(t) === norm(a.value) ? [i] : []));
      if (idx.length !== 1) return false;
      await loc.selectOption({ index: idx[0] }, { timeout: 5000 });
      await loc.dispatchEvent("change");
      return true;
    }
    case "check": {
      const opts = field?.options ?? [];
      const want = new Set(a.value.map(loose));
      if (![...want].every((w) => opts.some((o) => loose(o) === w))) return false;
      // Radio: click the wanted one only. Group: uncheck the unwanted first, so an exclusive "none" never sits with others.
      const order = opts.map((o, j) => ({ j, on: want.has(loose(o)) })).sort((x, y) => +x.on - +y.on);
      for (const { j, on } of order) {
        const input = dlg.locator(`[data-mcp-ffo="${a.ref}:${j}"]`).first();
        if (!(await input.count())) return false;
        const checked = await input.isChecked();
        if (checked === on || (a.kind === "radio" && !on)) continue;
        await clickOption(dlg, input);
        await pause(250, 600);
      }
      return true;
    }
    case "toggle": {
      const isInput = await loc.evaluate((e) => e.tagName === "INPUT").catch(() => false);
      const input = isInput ? loc : dlg.locator(`[data-mcp-ffo="${a.ref}:0"]`).first();
      if (!(await input.count())) return false;
      if ((await input.isChecked()) !== a.value) await clickOption(dlg, input);
      return (await input.isChecked()) === a.value;
    }
    case "typeahead": {
      await typeInto(loc, a.value);
      // Suggestions: the listbox the input points to, else one inside the dialog. Never Enter on a highlighted guess.
      const lb = (await loc.getAttribute("aria-controls")) || (await loc.getAttribute("aria-owns"));
      const options = lb ? page.locator(`[id="${lb.replace(/"/g, '\\"')}"] [role=option]`) : dlg.locator("[role=listbox] [role=option]");
      await options.first().waitFor({ state: "visible", timeout: 6000 }).catch(() => null);
      const texts = (await options.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, " ").trim());
      const i = pickTypeaheadOption(texts, a.targets, a.value);
      if (i === null) return false;
      await options.nth(i).click({ timeout: 5000 });
      await pause(400, 800);
      const v = await loc.inputValue({ timeout: 3000 }).catch(() => "");
      a.targets = [texts[i]]; // the later read-back compares with the suggestion actually chosen
      return loose(v) === loose(texts[i]) || loose(v).includes(loose(texts[i]).split(" ")[0] ?? "\u0000");
    }
    case "upload": {
      const isFile = await loc.evaluate((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type === "file").catch(() => false);
      if (!isFile) return false;
      await loc.setInputFiles(a.value, { timeout: 10000 });
      return true;
    }
  }
}

/** The re-read field for an action: same stamp and label, else the one field with that label and kind. */
function findAfter(fields: FillField[], a: PlanAction): FillField | undefined {
  const same = fields.find((f) => f.ref === a.ref && f.label === a.label);
  if (same) return same;
  const byLabel = fields.filter((f) => f.label === a.label && f.kind === a.kind);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

export type MakeFillOpts = {
  job: { title?: string | null; description?: string | null; company?: string | null; location?: string | null };
  /** Defaults to <data folder>/answers.json (cached loader). */
  answers?: Answers | null;
  /** The user confirmed sending CPF / salary / benefits (policy sensitive_confirmation: once). Default false. */
  allowSensitive?: boolean;
};

/** Maximum read -> plan -> fill rounds per step (answers can reveal follow-up questions). */
const MAX_PASSES = 3;

/**
 * FillStep for executeEasyApply. Per step: plan first; if any required field is unanswered nothing is
 * touched and ok:false lists them (apply.ts discards the dialog and reports needs_answer). Otherwise fill,
 * re-read, verify each value; any mismatch is reported as unanswered too. `answered` is the audit log
 * (labels + bank source; sensitive/personal values masked).
 */
export function makeFillStep(opts: MakeFillOpts): FillStep {
  const ctx: FillCtx = {
    title: opts.job.title,
    description: opts.job.description,
    company: opts.job.company,
    location: opts.job.location,
    language: jobLanguage(opts.job),
    country: jobCountry(opts.job.location),
    allowSensitive: opts.allowSensitive === true,
  };
  return async (page: Page, stepIndex: number) => {
    const answers = opts.answers ?? loadAnswers();
    if (!answers) return { ok: false, unanswered: [`${answersFile()} — missing (no answer bank)`] };
    const dlg = easyApplyDialog(page);
    const log = new Map<string, FillLog>();
    const keep = (l: FillLog) => {
      const k = `${l.label}|${l.kind}`;
      const old = log.get(k);
      if (!(old?.status === "filled" && l.status === "kept")) log.set(k, l);
    };
    const answered = () => [...log.values()];
    let prev: PlanAction[] = [];
    for (let pass = 0; pass <= MAX_PASSES; pass++) {
      const fields = await readFields(page, stepIndex);
      if (!fields) return { ok: false, unanswered: ["Easy Apply dialog — not found while filling"], answered: answered() };
      const bad = prev.filter((a) => !verifyAction(a, findAfter(fields, a)));
      if (bad.length) return { ok: false, unanswered: bad.map((a) => `${a.label} — verify_failed`), answered: answered() };
      if (pass === MAX_PASSES) return { ok: false, unanswered: ["step — fields kept changing after filling"], answered: answered() };
      const plan = planStep(fields, answers, ctx, stepIndex);
      plan.log.forEach(keep);
      if (!plan.ok) return { ok: false, unanswered: unansweredLines(plan.unanswered), answered: answered() };
      if (!plan.actions.length) return { ok: true, answered: answered() };
      for (const a of plan.actions) {
        const okAct = await act(page, dlg, a, fields.find((f) => f.ref === a.ref)).catch(() => false);
        if (!okAct) return { ok: false, unanswered: [`${a.label} — fill_failed`], answered: answered() };
        await pause(300, 900);
      }
      prev = plan.actions;
    }
    return { ok: false, unanswered: ["step — fill loop ended"], answered: answered() };
  };
}
