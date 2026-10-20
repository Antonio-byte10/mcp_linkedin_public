import type { Locator, Page } from "playwright-core";
import { config } from "../config.js";
import { getPage, hasTime } from "../browser/session.js";
import { nav, afterAction } from "../browser/nav.js";
import { pause, sleep } from "../browser/humanize.js";
import { ACCOUNT_LEVEL } from "../guard/ledger.js";
import { clip } from "../guard/untrusted.js";
import type { FillLog } from "./formfillPure.js";
import { parseJobLines } from "./jobs.js";
import { discardEasyApply, easyApplyDialog } from "./mapper.js";
import {
  APPLIED_RE,
  EASY_APPLY_BTN_RE,
  NEXT_RE,
  SUBMIT_RE,
  applyGate,
  dialogNamesCompany,
  pickErrors,
  submitState,
  type ErrorNode,
  type JobTop,
  type SubmitState,
} from "./writeRules.js";

/**
 * Fills the current Easy Apply step (answer bank, see formfill.ts makeFillStep). Called on every step
 * before advancing; ok:false stops the attempt (the dialog is discarded) and its labels are returned as
 * needs_answer. `answered` is the masked audit log of what was filled from where.
 */
export type FillStep = (page: Page, stepIndex: number) => Promise<{ ok: boolean; unanswered?: string[]; answered?: FillLog[] }>;

export type ApplyOptions = {
  maxSteps?: number;
  fillStep?: FillStep;
  /** May another step start (checked before every fill, the first included)? Default: hasTime(6000). */
  stepBudget?: () => boolean;
  /** May the submit be clicked? It needs ~12 s to fill, click and verify. Default: hasTime(12000). */
  submitBudget?: () => boolean;
  /** The job's company (local cache): the dialog title must name it before anything is filled. */
  company?: string | null;
  /** Re-check of the user's modality/location preferences against the job page's own top card. */
  fits?: (top: JobTop) => boolean;
};

export type ApplyResult = {
  success: boolean;
  /** done = submit verified; unverified = submit clicked, outcome unknown (may have gone out); skipped = nothing tried. */
  status: "done" | "failed" | "unverified" | "needs_answer" | "skipped";
  reason?: string;
  unanswered?: string[];
  errors?: string[];
  /** false = the Easy Apply dialog may still be open (the batch stops). */
  discarded?: boolean;
  /** The job page says it no longer accepts applications. */
  closed?: boolean;
  /** The job page says the user already applied (the caller marks it applied). */
  alreadyApplied?: boolean;
  /** Account-level problem: the caller stops the batch. */
  stop?: string;
  /** Audit log of the answers filled per step (labels + bank source; sensitive values masked). */
  answers?: FillLog[];
};

const fail = (reason: string, extra: Partial<ApplyResult> = {}): ApplyResult => ({ success: false, status: "failed", reason, ...extra });

/** Validation messages currently shown in the dialog (see pickErrors for the [role=alert] rule). */
async function dialogErrors(dlg: Locator): Promise<string[]> {
  const FIELD = ".artdeco-inline-feedback--error, [id$='-error'], [id^='error-message']";
  const nodes = await dlg
    .locator(`${FIELD}, [role=alert]`)
    .evaluateAll(
      (els, field) =>
        els.map((e) => ({
          alert: !e.matches(field),
          text: (e as HTMLElement).innerText ?? "",
          visible: !!((e as HTMLElement).offsetParent || e.getClientRects().length),
        })),
      FIELD,
    )
    .catch(() => [] as ErrorNode[]);
  return pickErrors(nodes).map((t) => clip(t, 200));
}

/** Progress + question labels: unchanged after "Next" means the step did not advance. */
const stepFingerprint = (dlg: Locator) =>
  dlg
    .evaluate((d) => {
      const pb = d.querySelector("[role=progressbar]");
      const progress = pb?.getAttribute("aria-valuenow") ?? d.textContent?.match(/\d+\s*%/)?.[0] ?? "";
      const labels = [...d.querySelectorAll("h3, label, legend")].map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
      return `${progress}#${labels.join("|")}`;
    }, undefined, { timeout: 5000 })
    .catch(() => "");

/**
 * Polls (~1 s apart) until the submit is confirmed, rejected by validation, an error toast shows, or `ms`
 * runs out (= pending/unknown). A closed dialog only confirms after two consecutive closed polls.
 */
async function waitSubmitOutcome(page: Page, dlg: Locator, ms: number): Promise<SubmitState> {
  const end = Date.now() + ms;
  let closedPolls = 0;
  for (;;) {
    await afterAction(page); // a checkpoint here throws; the caller turns it into unverified + stop
    const dialogOpen = (await dlg.count()) > 0;
    const texts = (sel: string) => page.locator(sel).allInnerTexts().catch(() => [] as string[]);
    const overlayText = (await texts("dialog[open], [role=dialog], [role=alertdialog]")).join("\n");
    const toastText = (await texts(".artdeco-toast-item, [role=alert], [role=status]")).join("\n");
    closedPolls = dialogOpen ? 0 : closedPolls + 1;
    const s = submitState({ dialogOpen, overlayText, toastText, errors: dialogOpen ? await dialogErrors(dlg) : [], closedPolls });
    if (s !== "pending" || Date.now() > end) return s;
    await sleep(1000);
  }
}

/** Closes the "application sent" dialog. Best effort: a failure here never changes the verified result. */
async function closeConfirmation(page: Page) {
  try {
    const d = page.locator("dialog[open], [role=dialog]").filter({ hasText: APPLIED_RE }).first();
    if (!(await d.count())) return;
    const close = d.locator("button[aria-label='Fechar'], button[aria-label='Dismiss']").or(d.getByRole("button", { name: /^(concluído|done)$/i })).first();
    if (await close.count()) await close.click({ timeout: 3000 });
  } catch {
    // ignored: the application is already verified
  }
}

/**
 * Easy Apply for one job. Success is reported only after the submit is VERIFIED (confirmation text,
 * or the dialog closed without a "save this application?" prompt). Every non-success attempt that
 * opened the dialog is discarded. Account-level errors before the submit are rethrown untouched
 * (no clicking around on a checkpoint page); after the submit they become unverified + stop.
 */
export async function executeEasyApply(jobId: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const { maxSteps = 12, fillStep, stepBudget = () => hasTime(6000), submitBudget = () => hasTime(12000) } = opts;
  // Audit C3: without the answer-bank filler the form would go out with whatever LinkedIn prefilled
  // (unconfirmed years, the preselected resume). Refuse before opening anything; the id stays open in the batch.
  if (!fillStep) return { success: false, status: "needs_answer", reason: "fill_engine_missing" };
  const page = await getPage();
  const st = { opened: false, clickedSubmit: false };
  const answers: FillLog[] = [];

  const attempt = async (): Promise<ApplyResult> => {
    await nav(page, `https://www.linkedin.com/jobs/view/${jobId}/`, "form");
    await page.locator("main").first().waitFor({ timeout: 8000 }).catch(() => null);
    await pause(1500, 2500);
    // Closed / applied / modality come from the job's own top card (before "Sobre a vaga"), never from the
    // description or a similar-jobs card further down the page.
    const mainText = await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => "");
    const parsed = parseJobLines(mainText.split("\n").map((s) => s.trim()).filter(Boolean));
    const gate = applyGate(page.url(), jobId, parsed, opts.fits);
    if (gate) return { success: false, ...gate };

    const btn = page.locator("main").getByRole("button", { name: EASY_APPLY_BTN_RE }).first();
    if (!(await btn.count())) return fail("no_easy_apply_button");
    st.opened = true; // from here on, a non-success ends with a discard
    await btn.click({ timeout: 5000 });
    const dlg = easyApplyDialog(page);
    await dlg.waitFor({ timeout: 10000 }).catch(() => null);
    await pause(1200, 2000);
    await afterAction(page);
    // The dialog must be this job's: its title names the company (a stale dialog or another job never gets filled).
    const dlgTitle = await dlg.locator("h2").first().innerText({ timeout: 3000 }).catch(() => "");
    if (!dialogNamesCompany(dlgTitle, opts.company)) return fail("dialog_company_mismatch");

    for (let i = 0; i < maxSteps; i++) {
      if (!stepBudget()) return fail("time_budget");
      if (!(await dlg.count())) return fail("unknown_dialog");

      const f = await fillStep(page, i);
      answers.push(...(f.answered ?? []));
      if (!f.ok) return { success: false, status: "needs_answer", reason: "needs_answer", unanswered: (f.unanswered ?? []).map((l) => clip(l, 200)) };

      const submit = dlg.getByRole("button", { name: SUBMIT_RE });
      const nSubmit = await submit.count();
      if (nSubmit > 1) return fail("ambiguous_submit_button");
      if (nSubmit === 1) {
        const errors = await dialogErrors(dlg);
        if (errors.length) return fail("blocked_by_required_fields", { errors });
        if (!(await submit.isEnabled({ timeout: 3000 }))) return fail("submit_disabled");
        // Never click a submit that cannot be verified inside the call: nothing is sent, the id stays open.
        if (!submitBudget()) return fail("time_budget");
        st.clickedSubmit = true; // conservative: a click that throws midway is still "maybe sent"
        await submit.click({ timeout: 5000 });
        const outcome = await waitSubmitOutcome(page, dlg, 9000);
        if (outcome === "confirmed") {
          await closeConfirmation(page);
          return { success: true, status: "done" };
        }
        if (outcome === "rejected") {
          st.clickedSubmit = false; // validation kept the dialog open: nothing was sent
          return fail("blocked_by_required_fields", { errors: await dialogErrors(dlg) });
        }
        return { success: false, status: "unverified", reason: outcome === "error" ? "unverified: error toast after submit" : "unverified" };
      }

      const next = dlg.getByRole("button", { name: NEXT_RE });
      if ((await next.count()) !== 1) return fail("no_next_button");
      const before = await stepFingerprint(dlg);
      await next.click({ timeout: 5000 });
      await pause(1200, 2000);
      await afterAction(page);
      const errors = await dialogErrors(dlg);
      if (errors.length) return fail("blocked_by_required_fields", { errors });
      if ((await stepFingerprint(dlg)) === before) return fail("blocked_no_progress");
    }
    return fail("max_steps");
  };

  let r: ApplyResult;
  try {
    r = await attempt();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    if (st.clickedSubmit) r = { success: false, status: "unverified", reason: `unverified: ${clip(msg, 200)}`, stop: ACCOUNT_LEVEL.test(msg) ? msg : undefined };
    else if (ACCOUNT_LEVEL.test(msg)) throw e;
    else r = fail(clip(msg, 300));
  }

  if (st.opened && r.status !== "done") {
    // An unverified submit whose dialog is gone has nothing to discard.
    const open = await easyApplyDialog(page).count().catch(() => 1);
    if (r.status !== "unverified" || open) {
      r.discarded = await discardEasyApply(page).catch(() => false);
      if (!r.discarded) r.stop ??= `DISCARD_FAILED: the Easy Apply dialog for job ${jobId} may still be open in the MCP ${config.browserName} window. Close it there ("Descartar").`;
    }
  }
  if (answers.length) r.answers = answers;
  return r;
}
