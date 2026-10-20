import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { getPage, hasTime } from "../browser/session.js";
import { afterAction, nav } from "../browser/nav.js";
import { pause } from "../browser/humanize.js";
import { config } from "../config.js";
import { APPLY_DIALOG_TITLE_RE, EASY_APPLY_DIALOG_SEL } from "./writeRules.js";
import { readEasyApplyDialog } from "./dialog.js";
import { loadAnswers } from "../answers/bank.js";
import { bankSecrets, clipSteps, emptyReason, finalizeStep, maskDeep, maskSteps, noEasyApplyError, type MappedStep, type RawStep } from "./mapperPure.js";
import { parseJobLines } from "./jobs.js";
import { upsertJob } from "../store/db.js";

/**
 * READ-ONLY mapping tools. They never type into fields, never choose options
 * and never click a submit button. They record structure so the apply flow
 * can later be written against real field types.
 *
 * Easy Apply (2026 UI): native <dialog open> with hashed CSS classes. Fields are
 * semantic: <label for=id>, aria-label on the control, <fieldset role=radiogroup>.
 * Footer: "Voltar" / "Avançar" / "Avaliar" (review) / "Enviar candidatura" (submit).
 * Closing asks "Salvar esta candidatura?" -> "Descartar" | "Salvar".
 */

export type { FieldKind, MappedField, MappedStep } from "./mapperPure.js";

/** Only the exact footer labels observed in Easy Apply; generic words like "Continuar" are excluded on purpose. */
const NEXT_RE = /^(Avançar|Avaliar|Next|Review)$/;
const SUBMIT_RE = /(enviar candidatura|submit application|^enviar$|^submit$)/i;

/** Reads the open Easy Apply dialog through the shared reader (read-only mode: no stamps, no resume flag). */
async function readDialog(page: Page): Promise<RawStep | null> {
  const r = await page.evaluate(readEasyApplyDialog, { titleRe: APPLY_DIALOG_TITLE_RE.source, opts: { fill: false } });
  if (!r) return null;
  const { resumeSection: _r, ...step } = r;
  return step;
}

/**
 * The open Easy Apply dialog: a native <dialog open> or an ARIA [role=dialog] whose h2 reads
 * "Candidate-se / Candidatar-se / Apply to". Shared by the mapper, apply.ts, formfill.ts and the discard.
 */
export function easyApplyDialog(page: Page) {
  return page.locator(EASY_APPLY_DIALOG_SEL).filter({ has: page.locator("h2", { hasText: APPLY_DIALOG_TITLE_RE }) }).first();
}

/** Opens Easy Apply via its aria-label only (the generic apply button may be an external-apply link). */
async function openEasyApply(page: Page): Promise<boolean> {
  // Scoped to <main>: a similar-jobs card elsewhere must not be the one opened.
  const btn = page.locator("main").getByRole("button", { name: /candidatura simplificada|easy apply/i }).first();
  if (!(await btn.count())) return false;
  await btn.click();
  await easyApplyDialog(page).waitFor({ timeout: 10000 }).catch(() => null);
  await pause(1200, 2000);
  return true;
}

/**
 * Close the dialog and choose "Descartar" so nothing is saved or submitted.
 * Returns true only when no dialog is left open.
 */
export async function discardEasyApply(page: Page): Promise<boolean> {
  const close = easyApplyDialog(page).locator("button[aria-label='Fechar'], button[aria-label='Dismiss']").first();
  if (await close.count()) await close.click({ timeout: 5000 }).catch(() => null);
  else await page.keyboard.press("Escape").catch(() => null);
  await pause(700, 1200);
  // Only inside the "Salvar esta candidatura?" confirm dialog (not e.g. a messaging draft overlay).
  const confirm = page.locator("dialog[open], [role=alertdialog]").filter({ hasText: /Salvar esta candidatura|Save this application/i }).first();
  const discard = confirm.getByRole("button", { name: /^(Descartar|Discard)$/ }).first();
  if (await discard.count()) await discard.click({ timeout: 5000 }).catch(() => null);
  await pause(500, 900);
  const easyLeft = await easyApplyDialog(page).count();
  const confirmLeft = await page.locator("dialog[open], [role=alertdialog]").filter({ hasText: /Salvar esta candidatura|Save this application/i }).count();
  return easyLeft + confirmLeft === 0;
}

const fingerprint = (s: Omit<MappedStep, "index">) => `${s.progress}|${s.section}|${s.fields.map((f) => f.label).join("|")}`;

export async function mapEasyApplyForm(jobId: string, maxSteps = 12, saveHtml = false) {
  const page = await getPage();
  await nav(page, `https://www.linkedin.com/jobs/view/${jobId}/`, "form");
  await page.waitForTimeout(2500);
  if (!(await openEasyApply(page))) {
    // Why not, from the job's own top card (the parse apply_execute uses): a closed or applied job is saved so
    // apply_prepare stops offering it.
    const mainText = await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => "");
    const top = parseJobLines(mainText.split("\n").map((s) => s.trim()).filter(Boolean));
    if (top.closed || top.applied) upsertJob({ id: jobId, closed: top.closed ? 1 : 0, applied: top.applied ? 1 : 0 });
    return { job_id: jobId, error: noEasyApplyError(top), steps: [] as MappedStep[] };
  }

  const steps: MappedStep[] = [];
  const html: string[] = [];
  let title = "";
  let stopped: "submit_step" | "blocked_by_required" | "no_next_button" | "unknown_dialog" | "max_steps" | "time_budget" | "error" = "max_steps";
  let discarded = false;
  let error: string | undefined;
  try {
    for (let i = 0; i < maxSteps; i++) {
      if (i > 0 && !hasTime(6000)) { stopped = "time_budget"; break; }
      const dlg = easyApplyDialog(page);
      if (!(await dlg.count())) { stopped = "unknown_dialog"; break; }
      title ||= (await dlg.locator("h2").first().innerText()).trim();
      const snap = await readDialog(page);
      if (!snap) { stopped = "unknown_dialog"; break; }
      steps.push(finalizeStep(snap, i));
      if (saveHtml) html.push(await dlg.evaluate((d) => d.outerHTML));
      if (await dlg.getByRole("button", { name: SUBMIT_RE }).count()) { stopped = "submit_step"; break; }
      const next = dlg.getByRole("button", { name: NEXT_RE });
      if ((await next.count()) !== 1) { stopped = "no_next_button"; break; }
      if (SUBMIT_RE.test((await next.innerText()).trim())) { stopped = "submit_step"; break; } // belt and braces
      await next.click({ timeout: 5000 });
      await pause(1200, 2000);
      await afterAction(page);
      const after = await readDialog(page);
      if (after && fingerprint(after) === fingerprint(snap)) {
        steps[steps.length - 1].errors = after.errors;
        stopped = "blocked_by_required";
        break;
      }
    }
  } catch (e) {
    stopped = "error";
    error = (e as Error).message;
  } finally {
    discarded = await discardEasyApply(page);
  }

  // Saved file and LLM reply share the same masked copy: no e-mail, phone or name of the account (the bank's own
  // values too, so the review step's free text is masked even when no field on the form was prefilled).
  const shown = clipSteps(maskSteps(steps, ownSecrets()));
  const result = { job_id: jobId, title, mapped_at: new Date().toISOString(), stopped, error, reason: emptyReason(stopped, shown, error), discarded, steps: shown };
  const dir = path.join(config.dataDir, "form-maps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify(result, null, 2));
  html.forEach((h, i) => fs.writeFileSync(path.join(dir, `${jobId}.step${i}.html`), h));
  if (!discarded) throw new Error(`DISCARD_FAILED: the Easy Apply dialog for job ${jobId} may still be open in the MCP ${config.browserName} window. Close it there ("Descartar").`);
  return result;
}

/** The account's own name/phone from answers.json; an invalid or missing bank must not lose a map (prefills still mask). */
function ownSecrets() {
  try {
    return bankSecrets(loadAnswers());
  } catch {
    return {};
  }
}

/** Generic structural dump of a LinkedIn page: for studying DOM before writing extractors. HTML saved only with save_html. */
export async function mapPage(url?: string, saveHtml = false) {
  const page = await getPage();
  if (url) {
    await nav(page, url, "page");
    await page.waitForTimeout(2500);
  } else {
    await afterAction(page);
  }
  const raw = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const cls = (e: Element) => [...e.classList].slice(0, 4).join(".");
    return {
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].slice(0, 30).map((h) => `${h.tagName} ${clean(h.textContent)}`),
      repeated: Object.entries(
        [...document.querySelectorAll("li, [data-job-id], [data-occludable-job-id], [componentkey]")].reduce<Record<string, number>>((a, e) => {
          const k = `${e.tagName.toLowerCase()}.${cls(e)}`;
          a[k] = (a[k] ?? 0) + 1;
          return a;
        }, {}),
      ).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 15),
      dataAttrs: [...new Set([...document.querySelectorAll("*")].flatMap((e) => e.getAttributeNames().filter((n) => n.startsWith("data-test") || n.startsWith("data-job") || n.startsWith("data-occ") || n === "componentkey")))].slice(0, 40),
      controls: [...document.querySelectorAll("main input, main select, main textarea, main button")].slice(0, 80).map((e) => ({
        tag: e.tagName.toLowerCase(), type: (e as HTMLInputElement).type, aria: e.getAttribute("aria-label"), text: clean(e.textContent),
      })),
    };
  });
  // The nav and "Me" menu show the account's own name: file and reply are masked like the form maps.
  const data = maskDeep(raw, ownSecrets());
  const dir = path.join(config.dataDir, "page-maps");
  fs.mkdirSync(dir, { recursive: true });
  // The query string tells searches apart: /search/results/people/?keywords=a and ?keywords=b must not overwrite each other.
  const u = new URL(data.url);
  const slug = (u.pathname.replace(/\W+/g, "_").slice(0, 60) || "root") + (u.search ? `_${crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 8)}` : "");
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(data, null, 2));
  if (saveHtml) fs.writeFileSync(path.join(dir, `${slug}.html`), await page.content());
  return data;
}
