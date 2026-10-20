// Run: npx tsx test/note-templates.test.ts   (pure: note templates, headline parsing, job-sheet parsers)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseSalaryRange, parseYearsRequired } from "../src/analysis/jobFields.js";
import { skillsInText } from "../src/analysis/skills.js";
import { connectNotePlan, firstNameOf, parseHeadline, renderNote } from "../src/linkedin/noteTemplate.js";
import { NOTE_MAX } from "../src/linkedin/writeRules.js";

let failed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).message}`);
  }
}

t("parseHeadline: the four common forms, PT and EN", () => {
  assert.deepEqual(parseHeadline("Data Analyst at Acme Corp"), { role: "Data Analyst", company: "Acme Corp" });
  assert.deepEqual(parseHeadline("Analista de Dados na Empresa X"), { role: "Analista de Dados", company: "Empresa X" });
  assert.deepEqual(parseHeadline("Gerente no Banco Y | SQL | Power BI"), { role: "Gerente", company: "Banco Y" });
  assert.deepEqual(parseHeadline("Engenheira de Dados em Acme"), { role: "Engenheira de Dados", company: "Acme" });
  assert.deepEqual(parseHeadline("Recrutadora | Acme Talentos"), { role: "Recrutadora", company: "Acme Talentos" });
  assert.deepEqual(parseHeadline("Tech Lead @ Acme"), { role: "Tech Lead", company: "Acme" });
});

t("parseHeadline: unparseable or ambiguous gives empty", () => {
  assert.deepEqual(parseHeadline("Especialista em dados"), { role: "", company: "" });
  // a skill/tool is not a company
  assert.deepEqual(parseHeadline("Analista de Dados | Python"), { role: "", company: "" });
  assert.deepEqual(parseHeadline("Analista de Dados | SQL"), { role: "", company: "" });
  assert.deepEqual(parseHeadline("Analista de Dados | Python, SQL"), { role: "", company: "" });
  assert.deepEqual(parseHeadline("Especialista em Power BI"), { role: "", company: "" });
  assert.deepEqual(parseHeadline("Data Analyst at Nubank"), { role: "Data Analyst", company: "Nubank" });
  assert.deepEqual(parseHeadline("Data | SQL | Python"), { role: "", company: "" });
  assert.deepEqual(parseHeadline(null), { role: "", company: "" });
  assert.deepEqual(parseHeadline("Open to work"), { role: "", company: "" });
});

t("renderNote: full data fills every placeholder", () => {
  const r = renderNote("Olá, {first_name}! Vi que você é {role} na {company}.", { first_name: "Ana", role: "Analista", company: "Acme" });
  assert.deepEqual(r, { ok: true, note: "Olá, Ana! Vi que você é Analista na Acme." });
});

t("renderNote: bracketed fragment is dropped when its data is missing", () => {
  const tpl = "Olá, {first_name}! Trabalho com BI[ e vi seu perfil como {role}][ na {company}]. Vamos conversar?";
  const r = renderNote(tpl, { first_name: "Ana" });
  assert.deepEqual(r, { ok: true, note: "Olá, Ana! Trabalho com BI. Vamos conversar?" });
  const r2 = renderNote(tpl, { first_name: "Ana", company: "Acme" });
  assert.deepEqual(r2, { ok: true, note: "Olá, Ana! Trabalho com BI na Acme. Vamos conversar?" });
});

t("renderNote: unbracketed sentence with an unfillable placeholder is dropped", () => {
  const r = renderNote("Olá, {first_name}! Admiro a {company}. Vamos conectar?", { first_name: "Ana" });
  assert.deepEqual(r, { ok: true, note: "Olá, Ana! Vamos conectar?" });
});

t("renderNote: never leaves { } [ ]; unknown placeholders and stray brackets go", () => {
  const r = renderNote("Oi {first_name}! {foo} bar. Ok] [x", { first_name: "Ana" });
  assert.ok(r.ok);
  if (r.ok) assert.ok(!/[{}[\]]/.test(r.note), r.note);
});

t("renderNote: no first name rejects; empty result rejects; over NOTE_MAX rejects", () => {
  const a = renderNote("Olá, {first_name}!", {});
  assert.equal(a.ok, false);
  const b = renderNote("[Sobre {company}]", { first_name: "Ana" });
  assert.equal(b.ok, false);
  const c = renderNote("Olá, {first_name}! " + "x".repeat(NOTE_MAX), { first_name: "Ana" });
  assert.equal(c.ok, false);
  if (!c.ok) assert.match(c.reason, /max 300/);
});

t("renderNote: third-party values are cleaned and cannot inject placeholders", () => {
  const r = renderNote("Oi {first_name}, {role}.", { first_name: "A\u200Bna", role: "{company} [x]" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.note, "Oi Ana, company x.");
  assert.equal(firstNameOf("\u202E Maria da Silva"), "Maria");
  assert.equal(firstNameOf("--"), "");
});

t("answers.template.json ships geral / recrutador and they render within the limit", () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "answers.template.json"), "utf8")).note_templates;
  for (const k of ["geral", "recrutador"]) {
    for (const vars of [{ first_name: "Ana", role: "Analista de Dados", company: "Acme" }, { first_name: "Ana" }]) {
      const r = renderNote(tpl[k], vars);
      assert.ok(r.ok, `${k}: ${JSON.stringify(r)}`);
      if (r.ok) assert.ok(!/[{}[\]]/.test(r.note) && r.note.length <= NOTE_MAX);
    }
  }
});

t("parseYearsRequired: PT-BR", () => {
  assert.equal(parseYearsRequired("Experiência de 3+ anos com SQL"), 3);
  assert.equal(parseYearsRequired("Mínimo de 2 anos de experiência"), 2);
  assert.equal(parseYearsRequired("Pelo menos 4 anos atuando com dados"), 4);
  assert.equal(parseYearsRequired("Experiência de 2 a 4 anos em BI"), 2);
  assert.equal(parseYearsRequired("Somos uma empresa com 20 anos no mercado"), null);
  assert.equal(parseYearsRequired("Sem requisito de tempo"), null);
});

t("parseYearsRequired: EN", () => {
  assert.equal(parseYearsRequired("At least 5 years of experience with Python"), 5);
  assert.equal(parseYearsRequired("5+ years of experience"), 5);
  assert.equal(parseYearsRequired("3-5 years experience in analytics"), 3);
  assert.equal(parseYearsRequired("Minimum 2 years in BI; 4 years experience with SQL"), 4);
  assert.equal(parseYearsRequired(null), null);
});

t("parseSalaryRange: PT-BR", () => {
  assert.equal(parseSalaryRange("Salário: R$ 5.000 - R$ 7.000 + benefícios"), "R$ 5.000 - R$ 7.000");
  assert.equal(parseSalaryRange("Remuneração R$ 8.000,00"), "R$ 8.000");
  assert.equal(parseSalaryRange("até R$ 6 mil"), "até R$ 6.000");
  assert.equal(parseSalaryRange("Looking for a candidate R$ 5.000"), "R$ 5.000", "'ate' inside a word is not 'até'");
  assert.equal(parseSalaryRange("de R$5.000 a R$ 7.500"), "R$ 5.000 - R$ 7.500");
  assert.equal(parseSalaryRange("Candidatos com 5 anos, salário a combinar"), "");
});

t("parseSalaryRange: EN", () => {
  assert.equal(parseSalaryRange("Pay $90k–$120k per year"), "US$ 90.000 - US$ 120.000");
  assert.equal(parseSalaryRange("$90-120k"), "US$ 90.000 - US$ 120.000");
  assert.equal(parseSalaryRange("up to $150k"), "até US$ 150.000");
  assert.equal(parseSalaryRange("competitive salary"), "");
});

t("skills: new data/BI entries are found, existing ones untouched", () => {
  const got = skillsInText("Experiência com Alteryx, Apache Superset, Terraform e governança de dados; SQL e Power BI");
  for (const s of ["Alteryx", "Apache Superset", "Terraform", "Data Governance", "SQL", "Power BI"]) assert.ok(got.includes(s), `${s} in ${got}`);
  assert.ok(skillsInText("SAS Viya and data quality checks").includes("SAS"));
  assert.ok(!skillsInText("Shared Services SAS Brasil").includes("SAS"));
});

t("connectNotePlan: matching template sends only the stored (previewed) note per id", () => {
  const meta = { note_template: "dados", notes: { a: "Olá, Ana!", b: "Olá, Beto!" } };
  const f = connectNotePlan(meta, { note_template: "dados" }, ["a", "b"]);
  assert.equal(f("a"), "Olá, Ana!");
  assert.equal(f("b"), "Olá, Beto!");
});

t("connectNotePlan: mismatched template key throws", () => {
  assert.throws(() => connectNotePlan({ note_template: "dados", notes: { a: "x" } }, { note_template: "recrutador" }, ["a"]), /re-?run connect_prepare|Run connect_prepare again/i);
});

t("connectNotePlan: note plus note_template together throws", () => {
  assert.throws(() => connectNotePlan({ note_template: "dados", notes: { a: "x" } }, { note: "hi", note_template: "dados" }, ["a"]), /not both/);
});

t("connectNotePlan: batch prepared without a template throws for note_template", () => {
  assert.throws(() => connectNotePlan({ names: { a: "Ana" } }, { note_template: "dados" }, ["a"]), /Run connect_prepare again/);
  assert.throws(() => connectNotePlan(undefined, { note_template: "dados" }, ["a"]), /Run connect_prepare again/);
});

t("connectNotePlan: an id missing from the stored notes throws", () => {
  assert.throws(() => connectNotePlan({ note_template: "dados", notes: { a: "x" } }, { note_template: "dados" }, ["a", "b"]), /Run connect_prepare again/);
  // inherited keys are not stored notes
  assert.throws(() => connectNotePlan({ note_template: "dados", notes: { a: "x" } }, { note_template: "dados" }, ["constructor"]), /Run connect_prepare again/);
});

t("connectNotePlan: with note_template the result never exposes caller text; plain note is trimmed and applies to all", () => {
  const f = connectNotePlan({ note_template: "dados", notes: { a: "stored" } }, { note_template: "dados" }, ["a"]);
  assert.equal(f("a"), "stored");
  assert.equal(f("zzz"), undefined); // unknown id: nothing to send, never a made-up note
  const g = connectNotePlan(undefined, { note: "  oi  " }, ["a", "b"]);
  assert.equal(g("a"), "oi");
  assert.equal(connectNotePlan(undefined, {}, ["a"])("a"), undefined);
});

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASS");
