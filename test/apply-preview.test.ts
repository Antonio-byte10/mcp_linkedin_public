// apply_prepare answers preview: saved form map + answer bank -> what apply_execute would send (no browser, temp folder).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPreview, loadFormMap, type FormMap } from "../src/linkedin/applyPreview.js";
import type { MappedField } from "../src/linkedin/mapperPure.js";
import { fakeAnswers } from "./_fixture-answers.js";

const A = fakeAnswers();
const PT_DESC =
  "Buscamos uma pessoa analista de dados para atuar com indicadores, SQL e Power BI. Você vai trabalhar com a área de negócios e com o time de engenharia para a empresa.";
const job = { title: "Analista de Dados", description: PT_DESC, company: "Acme", location: "São Paulo, SP (Remoto)" };
const f = (o: Partial<MappedField> & { label: string; kind: MappedField["kind"] }): MappedField => ({ required: true, ...o });

const map = (stopped: string, fields: MappedField[]): FormMap => ({
  mapped_at: "2026-10-15T12:00:00.000Z",
  stopped,
  steps: [{ index: 0, progress: "", section: "", buttons: [], errors: [], fields }],
});

test("no bank / no map: says so, still reports the job language", () => {
  assert.deepEqual(applyPreview(job, null, null), { language: "pt", form: "no_answer_bank" });
  assert.deepEqual(applyPreview(job, A, null), { language: "pt", form: "not_mapped" });
  // title only: no language, so the resume could not be chosen
  assert.equal(applyPreview({ ...job, description: null }, A, null).language, null);
});

test("mapped form: answered with source, PII masked, unknown question unanswered, sensitive separated", () => {
  const p = applyPreview(job, A, map("submit_step", [
    f({ label: "First name", kind: "text", key: "FIRST_NAME" }),
    f({ label: "Email", kind: "email", key: "EMAIL" }),
    f({ label: "CPF", kind: "text" }),
    f({ label: "Qual o seu time de futebol favorito?", kind: "text" }),
  ]));
  assert.equal(p.language, "pt");
  assert.ok(typeof p.form === "object");
  const form = p.form as Exclude<typeof p.form, string>;
  assert.equal(form.complete, true);
  assert.equal(form.ready, false); // the football question has no bank answer
  const first = form.answered.find((x) => x.label === "First name");
  assert.equal(first?.source, "profile.first_name");
  assert.equal(first?.value, "***"); // personal values never shown in clear
  assert.ok(!JSON.stringify(p).includes("Fulano"));
  assert.ok(!JSON.stringify(p).includes("fulano@example.com"));
  assert.deepEqual(form.needs_confirm_sensitive, ["CPF"]);
  assert.ok(!JSON.stringify(p).includes("000.000.000-00"));
  assert.equal(form.unanswered?.length, 1);
  assert.match(form.unanswered![0].label, /futebol/);
});

test("ready only when the map reached the submit step and nothing is missing", () => {
  const fields = [f({ label: "First name", kind: "text", key: "FIRST_NAME" })];
  const full = applyPreview(job, A, map("submit_step", fields)).form as { ready: boolean; complete: boolean };
  assert.deepEqual([full.ready, full.complete], [true, true]);
  const partial = applyPreview(job, A, map("time_budget", fields)).form as { ready: boolean; complete: boolean };
  assert.deepEqual([partial.ready, partial.complete], [false, false]);
});

test("long forms are capped with a count of what was left out", () => {
  const many = Array.from({ length: 40 }, () => f({ label: "First name", kind: "text", key: "FIRST_NAME" }));
  const form = applyPreview(job, A, map("submit_step", many)).form as { answered: unknown[]; answered_more?: number };
  assert.equal(form.answered.length, 30);
  assert.equal(form.answered_more, 10);
});

test("masked account data in the saved map is matched against the bank (e-mail select, phone, name)", () => {
  const p = applyPreview(job, A, map("submit_step", [
    f({ label: "Email*", kind: "select", key: "EMAIL", options: ["Selecionar uma opção", "fu***@example.com"], selected: ["fu***@example.com"] }),
    f({ label: "Phone", kind: "tel", key: "PHONE_MOBILE", prefilled: "***0000" }),
    f({ label: "First name", kind: "text", key: "FIRST_NAME", prefilled: "F***" }),
  ]));
  const form = p.form as { ready: boolean; answered: { label: string; kept?: boolean }[] };
  assert.equal(form.ready, true);
  assert.deepEqual(form.answered.map((x) => [x.label, x.kept]), [["Email*", true], ["Phone", true], ["First name", true]]);
  assert.ok(!JSON.stringify(p).includes("fulano@example.com"));
  // a different account's masked e-mail is not "restored" into the bank's
  const other = applyPreview(job, A, map("submit_step", [f({ label: "Email*", kind: "select", key: "EMAIL", options: ["x***@other.com"] })]));
  assert.equal((other.form as { ready: boolean }).ready, false);
});

test("loadFormMap: missing, broken, not a map, bad id -> null; valid map read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-preview-"));
  assert.equal(loadFormMap(dir, "1234567"), null);
  fs.writeFileSync(path.join(dir, "1234567.json"), "{ broken");
  assert.equal(loadFormMap(dir, "1234567"), null);
  fs.writeFileSync(path.join(dir, "1234567.json"), JSON.stringify({ steps: "no" }));
  assert.equal(loadFormMap(dir, "1234567"), null);
  assert.equal(loadFormMap(dir, "../1234567"), null);
  fs.writeFileSync(path.join(dir, "7654321.json"), JSON.stringify({ ...map("submit_step", [f({ label: "Email", kind: "email" })]), steps: [...map("x", []).steps, null] }));
  const m = loadFormMap(dir, "7654321");
  assert.equal(m?.stopped, "submit_step");
  assert.equal(m?.steps.length, 1); // the null step is dropped
});
