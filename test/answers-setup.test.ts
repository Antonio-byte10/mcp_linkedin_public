// Guided answers bank: check / init / applyUpdates / save (src/answers/setup.ts) and the terminal wizard.
// A temp LINKEDIN_DATA_DIR is set before any import: never the real data folder. Fake values only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-setup-"));
process.env.LINKEDIN_DATA_DIR = tmp;

const setup = await import("../src/answers/setup.js");
const { loadAnswers, answersFile } = await import("../src/answers/bank.js");
const { fakeAnswers } = await import("./_fixture-answers.js");
const { FIELDS, checkAnswers, initAnswers, applyUpdates, saveAnswers, loadTemplate, templatePath, checkReport, setAnswers, coerceLearned } = setup;

type Bank = Record<string, any>;
const template = (): Bank => loadTemplate();
const freshDir = () => fs.mkdtempSync(path.join(tmp, "case-"));
const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Bank)[k] : undefined), o);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A bank with every FIELDS required/recommended path filled with fake values. */
function filledBank(): Bank {
  const b = fakeAnswers() as Bank;
  b.target.hybrid_area = ["Cidade Teste"];
  b.education.degree.course = "Curso Teste";
  b.education.degree.institution = "Faculdade Teste";
  b.free_text.pitch_short = { pt: "Pitch curto de teste.", en: "Short test pitch." };
  return b;
}
const FAKE_VALUES = ["Fulano", "Detal", "fulano@example.com", "11900000000", "000.000.000-00", "Cidade Teste", "cv-fake-pt.pdf", "Acme Fake Ltda"];

test("FIELDS: every path exists in the template, no duplicates, choices only on choice/list", () => {
  const tpl = template();
  const seen = new Set<string>();
  for (const f of FIELDS) {
    assert.notEqual(get(tpl, f.path), undefined, `${f.path} is not in docs/answers.template.json`);
    assert.ok(!seen.has(f.path), `duplicate ${f.path}`);
    seen.add(f.path);
    if (f.kind === "choice") assert.ok(f.choices?.length, `${f.path} needs choices`);
    if (f.kind === "list") assert.ok(Array.isArray(get(tpl, f.path)), `${f.path} is a list but the template value is not an array`);
    assert.ok(f.label.length > 5);
  }
  for (const p of ["profile.first_name", "profile.cpf", "consents.truthfulness", "target.seniority"]) assert.ok(seen.has(p), p);
  assert.ok(FIELDS.filter((f) => f.level === "optional").every((f) => f.sensitive), "optional fields are the sensitive ones");
});

test("FIELDS: seniority, language and higher_ed choices are the values the code accepts", () => {
  const f = (p: string) => FIELDS.find((x) => x.path === p)!;
  assert.deepEqual(f("target.seniority").choices, ["internship", "entry", "associate", "senior", "director", "executive"]);
  assert.deepEqual(f("target.modalities").choices, ["remote", "hybrid", "onsite"]);
  assert.deepEqual(f("languages.english").choices, ["none", "basic", "intermediate", "advanced", "fluent", "native"]);
  assert.deepEqual(f("languages.english_linkedin_scale").choices, ["None", "Conversational", "Professional", "Native or bilingual"]);
  assert.deepEqual(f("education.higher_ed_status").choices, ["technologist_complete", "bachelor_complete", "in_progress", "none", "postgraduate_complete"]);
});

test("checkAnswers: null bank means exists:false and not ready", () => {
  const c = checkAnswers(null);
  assert.equal(c.exists, false);
  assert.equal(c.ready_to_apply, false);
  assert.equal(c.missing.required.length, FIELDS.filter((f) => f.level === "required").length);
  assert.equal(c.missing.recommended.length, FIELDS.filter((f) => f.level === "recommended").length);
});

test("the public template carries no persona: empty targets and skills, neutral note templates", () => {
  const tpl = template();
  for (const p of ["target.include_titles", "target.seniority", "target.modalities", "target.exclude_titles", "skills"]) assert.deepEqual(get(tpl, p), [], p);
  assert.deepEqual(Object.keys(tpl.note_templates), ["_note", "geral", "recrutador"]);
  const text = JSON.stringify(tpl).toLowerCase();
  for (const w of ["analista", "analyst", "power bi", "excel", "tech-lead", "dados e bi", "python"]) assert.ok(!text.includes(w), `template mentions "${w}"`);
  for (const k of ["geral", "recrutador"]) assert.ok(tpl.note_templates[k].length <= 300);
});

test("checkAnswers: the shipped template is not ready; every required path is missing; hybrid_area is a placeholder", () => {
  const tpl = template();
  const c = checkAnswers(tpl);
  assert.equal(c.exists, true);
  assert.equal(c.ready_to_apply, false);
  const missing = new Set(c.missing.required.map((m) => m.path));
  for (const f of FIELDS.filter((x) => x.level === "required")) assert.ok(missing.has(f.path), `${f.path} should be missing in the template`);
  assert.ok(missing.has("profile.first_name") && missing.has("consents.truthfulness") && missing.has("languages.english"));
  assert.ok(c.placeholders.includes("target.hybrid_area"));
  assert.ok(c.missing.recommended.some((m) => m.path === "target.hybrid_area"), "a <...> list item does not count as an answer");
  assert.equal(c.skills.count, 0);
});

test("checkAnswers: a fully filled fake bank is ready with empty missing lists", () => {
  const c = checkAnswers(filledBank());
  assert.equal(c.ready_to_apply, true);
  assert.deepEqual(c.missing, { required: [], recommended: [] });
  assert.deepEqual(c.placeholders, []);
  assert.deepEqual(c.inconsistencies, []);
  assert.ok(c.skills.count > 0);
});

test("checkAnswers: false and 0 are answers, not gaps", () => {
  const b = filledBank();
  b.mobility.accepts_onsite = false;
  b.availability.notice_period_days = 0;
  b.profile.currently_employed = false;
  assert.deepEqual(checkAnswers(b).missing, { required: [], recommended: [] });
});

test("checkAnswers: no knows:true skill means not ready; without_years lists the skills lacking years", () => {
  const b = filledBank();
  for (const s of b.skills) s.knows = null;
  assert.equal(checkAnswers(b).ready_to_apply, false);
  const b2 = filledBank();
  b2.skills[0].years = null;
  const c2 = checkAnswers(b2);
  assert.deepEqual(c2.skills.without_years, [b2.skills[0].key]);
  assert.equal(c2.ready_to_apply, true);
});

test("checkAnswers: each _consistency rule yields an inconsistency and blocks ready", () => {
  const a = filledBank();
  a.skills[0].years = 10; // > total 3
  const ca = checkAnswers(a);
  assert.equal(ca.inconsistencies.length, 1);
  assert.ok(ca.inconsistencies[0].includes(a.skills[0].key));
  assert.equal(ca.ready_to_apply, false);

  const b = filledBank();
  b.profile.years_in_data = 9;
  const cb = checkAnswers(b);
  assert.ok(cb.inconsistencies.some((s) => s.includes("profile.years_in_data")));
  assert.equal(cb.ready_to_apply, false);

  const c = filledBank();
  c.skills[1].knows = false;
  c.skills[1].years = 2;
  const cc = checkAnswers(c);
  assert.ok(cc.inconsistencies.some((s) => s.includes(c.skills[1].key)));
  c.skills[1].years = 0;
  assert.deepEqual(checkAnswers(c).inconsistencies, []);
  c.skills[1].years = null;
  assert.deepEqual(checkAnswers(c).inconsistencies, []);
});

test("checkAnswers: placeholders are found anywhere in the bank (not underscore keys)", () => {
  const b = filledBank();
  b.free_text.heard_from = "<onde soube>";
  b.education.certifications = ["<certificado>"];
  b._note = "<ignored>";
  const c = checkAnswers(b);
  assert.deepEqual([...c.placeholders].sort(), ["education.certifications", "free_text.heard_from"]);
});

test("checkAnswers: the output never contains personal values, even for a partial bank", () => {
  const b = filledBank();
  b.profile.email = null; // one required gap, everything else personal stays filled
  b.education.degree.course = null;
  const json = JSON.stringify(checkAnswers(b));
  for (const v of FAKE_VALUES) assert.ok(!json.includes(v), `check leaked ${v}`);
  assert.ok(json.includes("profile.email"));
  const rep = JSON.stringify(checkReport(path.join(freshDir(), "answers.json")));
  for (const v of FAKE_VALUES) assert.ok(!rep.includes(v));
});

test("templatePath points at the shipped template and loadTemplate parses it", () => {
  assert.ok(templatePath().endsWith(path.join("docs", "answers.template.json")));
  assert.equal(template().version, 1);
});

test("initAnswers: creates the folder and file when absent", () => {
  const file = path.join(freshDir(), "nested", "answers.json");
  const r = initAnswers(file);
  assert.deepEqual(r, { file, created: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), template());
});

test("initAnswers: second call leaves the file byte-equal", () => {
  const file = path.join(freshDir(), "answers.json");
  initAnswers(file);
  saveAnswers(file, applyUpdates(JSON.parse(fs.readFileSync(file, "utf8")), [{ path: "profile.first_name", value: "Fulano" }]));
  const before = fs.readFileSync(file);
  const r = initAnswers(file);
  assert.deepEqual(r, { file, created: false });
  assert.ok(fs.readFileSync(file).equals(before));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["answers.json"]);
});

test("initAnswers: overwrite keeps the old file as a timestamped backup and writes a fresh template", () => {
  const dir = freshDir();
  const file = path.join(dir, "answers.json");
  initAnswers(file);
  saveAnswers(file, applyUpdates(JSON.parse(fs.readFileSync(file, "utf8")), [{ path: "profile.first_name", value: "Fulano" }]));
  const old = fs.readFileSync(file, "utf8");
  const r = initAnswers(file, true);
  assert.equal(r.created, true);
  assert.match(path.basename(r.backup as string), /^answers\.backup-\d{8}-\d{6}\.json$/);
  assert.equal(path.dirname(r.backup as string), dir);
  assert.equal(fs.readFileSync(r.backup as string, "utf8"), old);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), template());
  const r2 = initAnswers(file, true); // same second: the backup name must not collide
  assert.notEqual(r2.backup, r.backup);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("answers.backup-")).length, 2);
});

test("initAnswers: overwrite on an absent file just creates it (no backup)", () => {
  const file = path.join(freshDir(), "answers.json");
  const r = initAnswers(file, true);
  assert.deepEqual(r, { file, created: true });
});

test("applyUpdates: valid leaf updates, input untouched, updated_at is today", () => {
  const bank = template();
  const snapshot = JSON.stringify(bank);
  const next = applyUpdates(bank, [
    { path: "profile.first_name", value: "Fulano" },
    { path: "profile.phone.national", value: 11900000000 },
    { path: "target.include_titles", value: ["analista", "data analyst"] },
    { path: "mobility.accepts_remote", value: "sim" },
    { path: "mobility.accepts_hybrid", value: false },
    { path: "profile.total_years_experience", value: "3,5" },
    { path: "languages.english", value: "FLUENT" },
    { path: "consents.truthfulness", value: "yes" },
  ]);
  assert.equal(JSON.stringify(bank), snapshot);
  assert.equal(next.profile.first_name, "Fulano");
  assert.equal(next.profile.phone.national, "11900000000", "a phone given as a number is stored as text");
  assert.deepEqual(next.target.include_titles, ["analista", "data analyst"]);
  assert.equal(next.mobility.accepts_remote, true);
  assert.equal(next.mobility.accepts_hybrid, false);
  assert.equal(next.profile.total_years_experience, 3.5);
  assert.equal(next.languages.english, "fluent");
  assert.equal(next.consents.truthfulness, true);
  assert.equal(next.updated_at, localToday());
});

test("applyUpdates: null and an empty string clear a value", () => {
  const b = applyUpdates(template(), [{ path: "profile.email", value: "a@b.co" }]);
  const c = applyUpdates(b, [{ path: "profile.email", value: null }, { path: "profile.last_name", value: "   " }]);
  assert.equal(c.profile.email, null);
  assert.equal(c.profile.last_name, null);
});

test("applyUpdates: invalid items throw and leave the input untouched (all-or-nothing)", () => {
  const bank = template();
  const snapshot = JSON.stringify(bank);
  const good = { path: "profile.first_name", value: "Fulano" };
  const bad: [string, { path: string; value: unknown }, RegExp][] = [
    ["unknown path", { path: "profile.nope", value: "x" }, /unknown path/i],
    ["unknown section", { path: "nope.first", value: "x" }, /unknown path/i],
    ["underscore note", { path: "target._note", value: "x" }, /_/],
    ["underscore consistency", { path: "_consistency", value: "x" }, /_/],
    ["object node", { path: "profile.phone", value: "x" }, /section|object/i],
    ["whole profile", { path: "profile", value: "x" }, /section|object/i],
    ["array for a string", { path: "profile.first_name", value: ["a"] }, /string|text|single value/i],
    ["string for an array", { path: "target.include_titles", value: "analista" }, /list|array/i],
    ["list with an object", { path: "target.include_titles", value: [{ a: 1 }] }, /list|array|strings/i],
    ["bad number", { path: "profile.total_years_experience", value: "tres" }, /number/i],
    ["negative number", { path: "profile.total_years_experience", value: -1 }, /number/i],
    ["bad choice", { path: "languages.english", value: "excelente" }, /one of/i],
    ["bad choice in list", { path: "target.seniority", value: ["entry", "mid_senior"] }, /one of/i],
    ["bad bool", { path: "mobility.accepts_remote", value: "talvez" }, /true|false|sim/i],
    ["skills through updates", { path: "skills", value: ["x"] }, /skills/i],
    ["version", { path: "version", value: 2 }, /version|read-only|cannot/i],
    ["bool for a text field", { path: "profile.first_name", value: true }, /text/i],
    ["empty path segment", { path: "profile..first_name", value: "x" }, /unknown path|invalid/i],
    ["proto", { path: "__proto__.x", value: "x" }, /unknown path|_/i],
  ];
  for (const [name, u, re] of bad) {
    assert.throws(() => applyUpdates(bank, [good, u]), re, name);
    assert.equal(JSON.stringify(bank), snapshot, `${name}: input changed`);
  }
  assert.throws(() => applyUpdates(bank, [good], [{ key: "" }]), /skill/i);
  assert.equal(JSON.stringify(bank), snapshot);
});

test("applyUpdates: the error names the failing item but never echoes the value", () => {
  assert.throws(
    () => applyUpdates(template(), [{ path: "profile.first_name", value: "ok" }, { path: "profile.total_years_experience", value: "SEGREDO-123" }]),
    (e: Error) => /updates\[1\]/.test(e.message) && /profile\.total_years_experience/.test(e.message) && !e.message.includes("SEGREDO-123"),
  );
});

test("applyUpdates: note_templates accepts new keys (<= 300 chars) and rejects bad ones", () => {
  const next = applyUpdates(template(), [{ path: "note_templates.minha-nota", value: "Olá, {first_name}!" }]);
  assert.equal(next.note_templates["minha-nota"], "Olá, {first_name}!");
  assert.equal(next.note_templates.geral.startsWith("Olá"), true, "other templates stay");
  assert.throws(() => applyUpdates(template(), [{ path: "note_templates.longa", value: "x".repeat(301) }]), /300/);
  applyUpdates(template(), [{ path: "note_templates.exata", value: "x".repeat(300) }]);
  assert.throws(() => applyUpdates(template(), [{ path: "note_templates.vazia", value: "  " }]), /non-empty|empty/i);
  assert.throws(() => applyUpdates(template(), [{ path: "note_templates.num", value: 3 }]), /string|text/i);
  assert.throws(() => applyUpdates(template(), [{ path: "note_templates._note", value: "x" }]), /_/);
  assert.throws(() => applyUpdates(template(), [{ path: "note_templates.a.b", value: "x" }]), /unknown path|invalid/i);
});

test("applyUpdates: learned takes a whole array of approved answers, with the documented shape", () => {
  const entry = { label_norm: "voce possui experiencia com python", kind: "radio", answer: "Yes" };
  const next = applyUpdates(template(), [{ path: "learned", value: [entry] }]);
  assert.deepEqual(next.learned, [entry]);
  assert.throws(() => applyUpdates(template(), [{ path: "learned", value: ["texto"] }]), /learned/);
  assert.throws(() => applyUpdates(template(), [{ path: "learned", value: [{ kind: "radio", answer: "Yes" }] }]), /label_norm/);
  assert.throws(() => applyUpdates(template(), [{ path: "learned", value: [{ label_norm: "x", answer: { a: 1 } }] }]), /answer/);
});

test("applyUpdates: creates a section the bank is missing, but refuses to walk through a non-object", () => {
  const bank = template();
  delete bank.consents;
  assert.equal(applyUpdates(bank, [{ path: "consents.truthfulness", value: true }]).consents.truthfulness, true);
  const broken = template();
  broken.profile = "oops";
  assert.throws(() => applyUpdates(broken, [{ path: "profile.first_name", value: "x" }]), /profile/);
});

test("applyUpdates: skills upsert (new, case-insensitive update, knows:false forces years 0)", () => {
  const bank = filledBank();
  const n = bank.skills.length;
  const next = applyUpdates(bank, [], [
    { key: "Tableau", years: 2 },
    { key: "SQL", years: 1.5 },
    { key: "Power BI", aliases: ["pbi", "power bi"], knows: true },
    { key: "excel", knows: false, years: 4 },
  ]);
  assert.equal(next.skills.length, n + 1, "only Tableau is new; SQL, Power BI and excel match existing keys");
  const tab = next.skills.find((s: Bank) => s.key === "Tableau");
  assert.deepEqual(tab, { key: "Tableau", aliases: ["Tableau"], years: 2, knows: null });
  assert.equal(next.skills.find((s: Bank) => s.key === "sql").years, 1.5);
  const pb = next.skills.find((s: Bank) => s.key === "power_bi");
  assert.deepEqual(pb.aliases, ["pbi", "power bi"]);
  assert.equal(pb.knows, true);
  const ex = next.skills.find((s: Bank) => s.key === "excel");
  assert.equal(ex.knows, false);
  assert.equal(ex.years, 0);
  assert.equal(bank.skills.find((s: Bank) => s.key === "excel").knows, true, "input untouched");
  assert.equal(next.updated_at, localToday());
});

test("applyUpdates: a new skill with knows:true and years null; bad skill input throws", () => {
  const next = applyUpdates(template(), [], [{ key: "Looker", knows: true, years: null }]);
  assert.deepEqual(next.skills.at(-1), { key: "Looker", aliases: ["Looker"], years: null, knows: true });
  assert.throws(() => applyUpdates(template(), [], [{ key: "x", years: -2 }]), /years/);
  assert.throws(() => applyUpdates(template(), [], [{ key: "x", years: 99 }]), /years/);
  assert.throws(() => applyUpdates(template(), [], [{ key: "x", aliases: [""] }]), /alias/i);
  assert.throws(() => applyUpdates(template(), [], [{ key: "x", knows: "sim" as unknown as boolean }]), /knows/);
  const noSkills = template();
  delete noSkills.skills;
  assert.equal(applyUpdates(noSkills, [], [{ key: "Go", knows: true }]).skills.length, 1);
});

test("saveAnswers writes atomically, formatted, and leaves no temp file", () => {
  const file = path.join(freshDir(), "answers.json");
  saveAnswers(file, { a: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 1\n}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["answers.json"]);
});

test("saveAnswers + loadAnswers: the cache refreshes immediately, even for a same-size value", () => {
  const file = path.join(freshDir(), "answers.json");
  saveAnswers(file, { v: "aaaa" });
  assert.equal(loadAnswers(file)?.v, "aaaa");
  for (const v of ["bbbb", "cccc", "dddd", "eeee"]) {
    saveAnswers(file, { v });
    assert.equal(loadAnswers(file)?.v, v);
  }
});

test("setAnswers (the answers_set core): saves, returns the check without values, NO_ANSWERS when absent", () => {
  const file = path.join(freshDir(), "answers.json");
  assert.throws(() => setAnswers(file, { updates: [{ path: "profile.first_name", value: "Fulano" }] }), /NO_ANSWERS: run answers_init first/);
  initAnswers(file);
  assert.throws(() => setAnswers(file, {}), /at least one/i);
  assert.throws(() => setAnswers(file, { updates: [] }), /at least one/i);
  const r = setAnswers(file, { updates: [{ path: "profile.first_name", value: "Fulano" }, { path: "profile.cpf", value: "000.000.000-00" }], skills: [{ key: "Tableau", years: 1, knows: true }] });
  assert.equal(r.saved, 3);
  assert.ok(!JSON.stringify(r).includes("Fulano") && !JSON.stringify(r).includes("000.000.000-00"));
  assert.equal(loadAnswers(file)?.profile.first_name, "Fulano");
  assert.ok(!r.check.missing.required.some((m) => m.path === "profile.first_name"));
  assert.equal(r.check.skills.count, 1);
  // a rejected batch changes nothing
  assert.throws(() => setAnswers(file, { updates: [{ path: "profile.last_name", value: "Detal" }, { path: "profile.nope", value: 1 }] }), /unknown path/i);
  assert.equal(loadAnswers(file)?.profile.last_name, null);
});

test("checkReport: file, check and at most 8 next_questions, required first", () => {
  const file = path.join(freshDir(), "answers.json");
  const none = checkReport(file);
  assert.equal(none.exists, false);
  assert.equal(none.file, file);
  assert.equal(none.next_questions.length, 8);
  initAnswers(file);
  const r = checkReport(file);
  assert.equal(r.exists, true);
  assert.equal(r.next_questions.length, 8);
  assert.deepEqual(r.next_questions.map((q) => q.path), r.missing.required.slice(0, 8).map((q) => q.path));
  assert.ok(r.next_questions[0].label && r.next_questions[0].kind);
  const b = filledBank();
  b.education.degree.course = null;
  fs.writeFileSync(file, JSON.stringify(b));
  assert.deepEqual(checkReport(file).next_questions.map((q) => q.path), ["education.degree.course"]);
});

test("the real data folder is never used by this file", () => {
  assert.ok(answersFile().startsWith(tmp));
});

// ---------------------------------------------------------------------------------------------------
// Terminal wizard (src/cli/setup-answers.ts): runWizard with a scripted `ask`, no TTY.

const { runWizard } = await import("../src/cli/setup-answers.js");

const ALL_ANSWERS: Record<string, string | string[]> = {
  "profile.first_name": "Fulano",
  "profile.last_name": "Detal",
  "profile.email": "fulano@example.com",
  "profile.phone.country_option": "Brazil (+55)",
  "profile.phone.national": "11900000000",
  "profile.location_city.pt": "Cidade Teste, São Paulo, Brasil",
  "profile.location_city.en": "Cidade Teste, Sao Paulo, Brazil",
  "profile.location_city.typeahead_query": "Cidade Teste",
  "profile.total_years_experience": ["tres", "3"], // the first one is not a number: asked again
  "profile.years_in_data": "2",
  "mobility.accepts_remote": "s",
  "mobility.accepts_hybrid": "sim",
  "mobility.accepts_onsite": "não",
  "target.include_titles": "analista de dados, data analyst",
  "target.seniority": "entry, associate",
  "target.modalities": "remote, hybrid",
  "languages.english": "5", // by number: fluent
  "languages.english_linkedin_scale": "professional", // case-insensitive
  "documents.resume_by_language.pt": "cv-fake-pt.pdf",
  "documents.resume_by_language.en": "cv-fake-en.pdf",
  "consents.privacy_lgpd": "yes",
  "consents.truthfulness": "s",
  "profile.linkedin_url": "https://www.linkedin.com/in/fake",
  "profile.current_role": "Analista",
  "profile.currently_employed": "n",
  "target.hybrid_area": "Cidade Teste",
  "education.higher_ed_status": "2",
  "education.degree.course": "Curso Teste",
  "education.degree.institution": "Faculdade Teste",
  "availability.notice_period_days": "30",
  "free_text.pitch_short.pt": "Pitch de teste.",
  "free_text.pitch_short.en": "Test pitch.",
};

/** Scripted I/O: answers are looked up by the field the question is about; anything unscripted is an empty answer. */
function scripted(answers: Record<string, string | string[]>, extra: { skills?: string; years?: Record<string, string[]>; sensitive?: string } = {}) {
  const queue = new Map(Object.entries(answers).map(([k, v]) => [k, [...(Array.isArray(v) ? v : [v])]]));
  const asked: string[] = [];
  const said: string[] = [];
  const byLabel = FIELDS.map((f) => [f.label, f.path] as const);
  const io = {
    say: (s: string) => void said.push(s),
    ask: async (q: string) => {
      asked.push(q);
      const hit = byLabel.find(([label]) => q.includes(label));
      if (hit) return queue.get(hit[1])?.shift() ?? "";
      if (/Quais ferramentas/.test(q)) return extra.skills ?? "";
      const m = q.match(/Há quantos anos você usa (.+)\?/);
      if (m) return extra.years?.[m[1]]?.shift() ?? "";
      if (/sensíve/.test(q)) return extra.sensitive ?? "";
      return "";
    },
  };
  return { io, asked, said };
}
const askedFor = (asked: string[], label: string) => asked.filter((q) => q.includes(label)).length;
const labelOf = (p: string) => (FIELDS.find((f) => f.path === p) as { label: string }).label;

test("runWizard: fills the required and recommended fields, the skills with years, skips sensitive, re-asks a bad number", async () => {
  const file = path.join(freshDir(), "answers.json");
  const { io, asked, said } = scripted(ALL_ANSWERS, { skills: "Excel, SQL, Tableau, excel", years: { Excel: ["2"], SQL: ["10", "1,5"], Tableau: [""] } });
  const check = await runWizard(io, file);
  assert.equal(check.ready_to_apply, true);
  assert.deepEqual(check.missing, { required: [], recommended: [] });
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(b.profile.first_name, "Fulano");
  assert.equal(b.profile.total_years_experience, 3);
  assert.equal(askedFor(asked, labelOf("profile.total_years_experience")), 2, "the bad number was asked again");
  assert.equal(b.mobility.accepts_remote, true);
  assert.equal(b.mobility.accepts_onsite, false);
  assert.deepEqual(b.target.seniority, ["entry", "associate"]);
  assert.deepEqual(b.target.include_titles, ["analista de dados", "data analyst"]);
  assert.deepEqual(b.target.modalities, ["remote", "hybrid"]);
  for (const p of ["target.include_titles", "target.seniority", "target.modalities"]) assert.equal(askedFor(asked, labelOf(p)), 1, `${p} is asked: the template ships it empty`);
  assert.deepEqual(b.target.hybrid_area, ["Cidade Teste"]);
  assert.equal(b.languages.english, "fluent");
  assert.equal(b.languages.english_linkedin_scale, "Professional");
  assert.equal(b.education.higher_ed_status, "bachelor_complete");
  assert.equal(b.availability.notice_period_days, 30);
  assert.equal(b.profile.currently_employed, false);
  // the template has no skills: all three are created ("excel" typed twice collapses)
  const sk = (k: string) => b.skills.find((s: Bank) => s.key === k);
  assert.equal(b.skills.length, 3);
  assert.deepEqual(sk("Excel"), { key: "Excel", aliases: ["Excel"], years: 2, knows: true });
  assert.deepEqual([sk("SQL").years, sk("SQL").knows], [1.5, true]);
  assert.deepEqual(sk("Tableau"), { key: "Tableau", aliases: ["Tableau"], years: null, knows: true });
  assert.equal(askedFor(asked, "Há quantos anos você usa SQL"), 2, "10 years > 3 total was refused and asked again");
  assert.ok(said.some((s) => s.includes(file)), "says where the file is");
  assert.ok(said.some((s) => /criado/i.test(s)));
  // sensitive fields: asked once as a yes/no, answered no (default), so no CPF / salary question
  assert.equal(asked.filter((q) => /sensíve/.test(q)).length, 1);
  assert.ok(!asked.some((q) => !/sensíve/.test(q) && /CPF|Pretensão salarial/i.test(q)));
  assert.equal(b.profile.cpf, null);
  assert.ok(said.some((s) => /pronto/i.test(s)) && said.some((s) => /answers_check/.test(s)));
});

test("runWizard: sensitive fields are asked only after an explicit yes; Brazilian money formats parse", async () => {
  const file = path.join(freshDir(), "answers.json");
  const { io, asked } = scripted(
    { ...ALL_ANSWERS, "profile.cpf": "000.000.000-00", "compensation.desired_clt_monthly_brl.min": "R$ 5.000", "compensation.desired_clt_monthly_brl.max": "7000,50" },
    { skills: "Excel", years: { Excel: ["1"] }, sensitive: "s" },
  );
  await runWizard(io, file);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(b.profile.cpf, "000.000.000-00");
  assert.equal(b.compensation.desired_clt_monthly_brl.min, 5000);
  assert.equal(b.compensation.desired_clt_monthly_brl.max, 7000.5);
  assert.equal(b.compensation.desired_clt_monthly_brl.single_value, null, "an empty answer skips");
  assert.ok(asked.some((q) => q.includes("CPF")));
});

test("runWizard: a second run resumes: nothing required is asked, the file is not touched", async () => {
  const file = path.join(freshDir(), "answers.json");
  await runWizard(scripted(ALL_ANSWERS, { skills: "Excel", years: { Excel: ["1"] } }).io, file);
  const before = fs.readFileSync(file);
  const second = scripted({});
  const check = await runWizard(second.io, file);
  assert.equal(check.ready_to_apply, true);
  for (const f of FIELDS.filter((x) => x.level !== "optional")) assert.equal(askedFor(second.asked, f.label), 0, `re-asked: ${f.path}`);
  assert.ok(!second.asked.some((q) => /Quais ferramentas/.test(q)), "skills already there");
  assert.ok(fs.readFileSync(file).equals(before), "the file is byte-equal");
  assert.ok(second.said.some((s) => /retomando/i.test(s)));
});

test("runWizard: never overwrites an existing bank and only asks what is missing", async () => {
  const file = path.join(freshDir(), "answers.json");
  initAnswers(file);
  saveAnswers(file, applyUpdates(JSON.parse(fs.readFileSync(file, "utf8")), [{ path: "profile.first_name", value: "Existente" }]));
  const s = scripted({ "profile.last_name": "Novo" });
  await runWizard(s.io, file);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(b.profile.first_name, "Existente");
  assert.equal(b.profile.last_name, "Novo");
  assert.equal(askedFor(s.asked, labelOf("profile.first_name")), 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["answers.json"]);
});

test("runWizard: an invalid answer is refused with the reason, asked up to 3 times, then skipped", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "mobility.accepts_remote": ["talvez", "quem sabe", "sei lá", "s"] });
  await runWizard(s.io, file);
  assert.equal(askedFor(s.asked, labelOf("mobility.accepts_remote")), 3);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mobility.accepts_remote, null, "skipped after 3 tries; the 4th scripted answer was never used");
  assert.ok(s.said.some((m) => /s\/n|sim/i.test(m)));
  assert.ok(s.said.some((m) => /pulando/i.test(m)));
});

test("runWizard: progress is saved after each accepted answer (quitting keeps it)", async () => {
  const file = path.join(freshDir(), "answers.json");
  let n = 0;
  const io = {
    say: () => {},
    ask: async (q: string) => {
      if (++n === 4) throw new Error("input closed");
      return q.includes(labelOf("profile.first_name")) ? "Fulano" : q.includes(labelOf("profile.last_name")) ? "Detal" : q.includes(labelOf("profile.email")) ? "fulano@example.com" : "";
    },
  };
  await assert.rejects(runWizard(io, file), /input closed/);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([b.profile.first_name, b.profile.last_name, b.profile.email], ["Fulano", "Detal", "fulano@example.com"]);
});

test("runWizard: duplicate and blank skill names collapse; a skill the user does not list gets no question", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "profile.total_years_experience": "5" }, { skills: "Python,  , python", years: { Python: ["4"] } });
  await runWizard(s.io, file);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const py = b.skills.filter((x: Bank) => x.key === "Python");
  assert.equal(b.skills.length, 1);
  assert.equal(py.length, 1);
  assert.deepEqual([py[0].years, py[0].knows], [4, true]);
  assert.equal(askedFor(s.asked, "Há quantos anos você usa Python"), 1);
  assert.ok(!s.asked.some((q) => q.includes("usa Excel")));
});

test("runWizard: a typed name that is an alias of an existing skill reuses it (no duplicate)", async () => {
  const file = path.join(freshDir(), "answers.json");
  initAnswers(file);
  saveAnswers(file, applyUpdates(loadAnswers(file) as Bank, [{ path: "profile.total_years_experience", value: 5 }], [{ key: "power_bi", aliases: ["power bi", "microsoft power bi"] }]));
  const s = scripted({}, { skills: "Microsoft Power BI, Power BI", years: { "Microsoft Power BI": ["3"] } });
  await runWizard(s.io, file);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(b.skills.length, 1);
  assert.deepEqual([b.skills[0].key, b.skills[0].years, b.skills[0].knows], ["power_bi", 3, true]);
  assert.deepEqual(b.skills[0].aliases, ["power bi", "microsoft power bi"]);
});

test("runWizard: a skill name over 60 characters is reported and skipped, the others are still saved", async () => {
  const file = path.join(freshDir(), "answers.json");
  const long = "x".repeat(61);
  const s = scripted({ "profile.total_years_experience": "5" }, { skills: `${long}, Go`, years: { Go: ["2"] } });
  const check = await runWizard(s.io, file);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(b.skills.map((x: Bank) => x.key), ["Go"]);
  assert.ok(s.said.some((m) => m.includes("60 caracteres")), "says why");
  assert.ok(!s.asked.some((q) => q.includes(long)), "never asks years for it");
  assert.equal(check.skills.count, 1);
});

test("runWizard: a number above the field maximum is refused with the reason", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "profile.total_years_experience": ["99", "4"] });
  await runWizard(s.io, file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profile.total_years_experience, 4);
  assert.ok(s.said.some((m) => /grande demais.*60/.test(m)));
});

test("applyUpdates: numbers are capped per field (years 60, notice 365, money 1e9)", () => {
  const ok = applyUpdates(template(), [
    { path: "profile.total_years_experience", value: 60 },
    { path: "availability.notice_period_days", value: "365" },
    { path: "compensation.desired_clt_monthly_brl.max", value: 1_000_000_000 },
  ]);
  assert.equal(ok.profile.total_years_experience, 60);
  assert.equal(ok.availability.notice_period_days, 365);
  for (const [p, v] of [["profile.total_years_experience", 61], ["availability.notice_period_days", 366], ["compensation.desired_clt_monthly_brl.min", 1_000_000_001], ["compensation.desired_pj_monthly.brazil_brl_min", "99999999999"]] as const) {
    assert.throws(() => applyUpdates(template(), [{ path: p, value: v }]), /between 0 and/, p);
  }
});

test("learned: unknown keys are not copied through; sizes are bounded", () => {
  const next = applyUpdates(template(), [{ path: "learned", value: [{ label_norm: "x", kind: "radio", answer: ["a", "b"], extra: "no", secret: { a: 1 } }] }]);
  assert.deepEqual(next.learned, [{ label_norm: "x", kind: "radio", answer: ["a", "b"] }]);
  assert.deepEqual(coerceLearned([{ label_norm: "y", answer: true }]), [{ label_norm: "y", answer: true }]);
  assert.throws(() => coerceLearned([{ label_norm: "x".repeat(501), answer: "a" }]), /label_norm/);
  assert.throws(() => coerceLearned([{ label_norm: "x", answer: "a".repeat(2001) }]), /answer/);
  assert.throws(() => coerceLearned([{ label_norm: "x", kind: "k".repeat(41), answer: "a" }]), /kind/);
  assert.throws(() => coerceLearned(Array.from({ length: 201 }, () => ({ label_norm: "x", answer: "a" }))), /at most 200/);
});

test("saveAnswers: a failed or partial write removes the temp file and keeps the old bank", () => {
  const file = path.join(freshDir(), "answers.json");
  saveAnswers(file, { v: 1 });
  const real = fs.writeFileSync;
  (fs as any).writeFileSync = (p: string, data: string) => {
    real(p, String(data).slice(0, 3)); // partial content on disk...
    throw new Error("disk full"); // ...then the write fails
  };
  try {
    assert.throws(() => saveAnswers(file, { v: 2 }), /disk full/);
  } finally {
    (fs as any).writeFileSync = real;
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["answers.json"]);
  assert.equal(loadAnswers(file)?.v, 1);
});

// ---------------------------------------------------------------------------------------------------
// Final review: upload paths, negative numbers, reserved keys, no file content in errors, rollback, temp name.

test("applyUpdates: file paths that get uploaded are never set through the tool (hand-edit only)", () => {
  for (const p of ["documents.resume_paths.pt", "documents.resume_paths.en", "documents.cover_letter.file"]) {
    assert.throws(() => applyUpdates(template(), [{ path: p, value: "C:/Users/Fulano/cv-fake.pdf" }]), /edite à mão no answers\.json/, p);
    assert.throws(() => applyUpdates(template(), [{ path: p, value: null }]), /edite à mão no answers\.json/, `${p} (clearing too)`);
  }
  // the file NAME used to pick a saved resume on LinkedIn is not an upload path
  const ok = applyUpdates(template(), [{ path: "documents.resume_by_language.pt", value: "cv-fake-pt.pdf" }]);
  assert.equal(ok.documents.resume_by_language.pt, "cv-fake-pt.pdf");
  // the error names the item but never echoes the path value
  assert.throws(() => applyUpdates(template(), [{ path: "documents.resume_paths.pt", value: "C:/segredo/cv.pdf" }]), (e: Error) => !e.message.includes("segredo"));
});

test("applyUpdates: a number is never negative, for any template leaf and inside lists", () => {
  assert.throws(() => applyUpdates(template(), [{ path: "profile.years_in_data", value: -5 }]), /between 0 and/);
  assert.throws(() => applyUpdates(template(), [{ path: "education.degree.year", value: -1 }]), />= 0|between 0 and/);
  assert.throws(() => applyUpdates(template(), [{ path: "target.include_titles", value: ["ok", -3] }]), />= 0|negative/);
  assert.equal(applyUpdates(template(), [{ path: "profile.years_in_data", value: "2,5" }]).profile.years_in_data, 2.5);
  assert.equal(applyUpdates(template(), [{ path: "education.degree.year", value: 2020 }]).education.degree.year, 2020);
});

test("FIELDS: profile.years_in_data is a recommended number with a maximum of 60", () => {
  const f = FIELDS.find((x) => x.path === "profile.years_in_data");
  assert.ok(f);
  assert.deepEqual([f.kind, f.level, f.max], ["number", "recommended", 60]);
  assert.throws(() => applyUpdates(template(), [{ path: "profile.years_in_data", value: 61 }]), /between 0 and 60/);
});

test("applyUpdates: note_templates refuses reserved and underscore keys", () => {
  for (const k of ["__proto__", "constructor", "prototype", "_hidden", "_note"]) {
    assert.throws(() => applyUpdates(template(), [{ path: `note_templates.${k}`, value: "Olá" }]), /invalid note template name|not editable/, k);
  }
  const next = applyUpdates(template(), [{ path: "note_templates.constructor2", value: "Olá" }]);
  assert.equal(next.note_templates.constructor2, "Olá");
  assert.equal(Object.getPrototypeOf(next.note_templates), Object.prototype);
});

test("loadAnswers: the invalid-JSON error carries the position but never quotes the file content", () => {
  const file = path.join(freshDir(), "answers.json");
  fs.writeFileSync(file, "CPF 123.456.789-00 {oops");
  let msg = "";
  try {
    loadAnswers(file);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /invalid JSON/);
  assert.ok(!msg.includes("123.456.789-00") && !msg.includes("CPF"), msg);
  fs.writeFileSync(file, '{\n  "profile": { "cpf": 123.456.789-00 }\n}');
  try {
    loadAnswers(file);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /line 2, column \d+/);
  assert.ok(!msg.includes("123.456.789-00"), msg);
});

test("initAnswers: a failed template write after the backup rename says where the backup is and restores it", () => {
  const dir = freshDir();
  const file = path.join(dir, "answers.json");
  fs.writeFileSync(file, '{"mine":1}\n');
  const real = fs.writeFileSync;
  (fs as any).writeFileSync = () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  let err: Error | undefined;
  try {
    initAnswers(file, true);
  } catch (e) {
    err = e as Error;
  } finally {
    (fs as any).writeFileSync = real;
  }
  assert.ok(err);
  assert.match(err.message, /disk full/, "keeps the original error");
  assert.match(err.message, /answers\.backup-\d{8}-\d{6}\.json/, "names the backup");
  assert.equal(fs.readFileSync(file, "utf8"), '{"mine":1}\n', "the old file is back");
  assert.deepEqual(fs.readdirSync(dir), ["answers.json"]);
});

test("initAnswers: when the restore also fails, the error points at the backup file that still exists", () => {
  const dir = freshDir();
  const file = path.join(dir, "answers.json");
  fs.writeFileSync(file, '{"mine":2}\n');
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  let renames = 0;
  (fs as any).writeFileSync = () => {
    throw new Error("disk full");
  };
  (fs as any).renameSync = (a: string, b: string) => {
    if (++renames > 1) throw new Error("rename blocked");
    return realRename(a, b);
  };
  let err: Error | undefined;
  try {
    initAnswers(file, true);
  } catch (e) {
    err = e as Error;
  } finally {
    (fs as any).writeFileSync = realWrite;
    (fs as any).renameSync = realRename;
  }
  assert.ok(err);
  assert.match(err.message, /disk full/);
  const backup = fs.readdirSync(dir).find((n) => n.startsWith("answers.backup-")) as string;
  assert.ok(backup, "the backup is still there");
  assert.ok(err.message.includes(backup), err.message);
  assert.equal(fs.readFileSync(path.join(dir, backup), "utf8"), '{"mine":2}\n');
});

test("saveAnswers: the temp file name carries the process id and is removed when the write fails", () => {
  const file = path.join(freshDir(), "answers.json");
  const real = fs.writeFileSync;
  const seen: string[] = [];
  (fs as any).writeFileSync = (p: string, data: string) => {
    seen.push(String(p));
    real(p, String(data).slice(0, 2));
    throw new Error("disk full");
  };
  try {
    assert.throws(() => saveAnswers(file, { v: 1 }), /disk full/);
  } finally {
    (fs as any).writeFileSync = real;
  }
  assert.deepEqual(seen, [`${file}.${process.pid}.tmp`]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
  const names: string[] = [];
  (fs as any).writeFileSync = (p: string, data: string) => {
    names.push(path.basename(String(p)));
    return real(p, data);
  };
  try {
    saveAnswers(file, { v: 2 });
  } finally {
    (fs as any).writeFileSync = real;
  }
  assert.deepEqual(names, [`answers.json.${process.pid}.tmp`]);
});

test("setup-answers CLI: input that ends (Ctrl+C / closed pipe) keeps progress, says so and exits 0", () => {
  const dir = freshDir();
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli/setup-answers.ts")], {
    input: "Fulano\nDetal\n",
    encoding: "utf8",
    env: { ...process.env, LINKEDIN_DATA_DIR: dir },
    timeout: 60000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /salv/i);
  assert.ok(!/unsettled/i.test(r.stderr), r.stderr);
  const b = JSON.parse(fs.readFileSync(path.join(dir, "answers.json"), "utf8"));
  assert.deepEqual([b.profile.first_name, b.profile.last_name], ["Fulano", "Detal"]);
});

test("applyUpdates: a numeric string on a number-ish leaf outside FIELDS becomes a number and is never negative; text leaves are left alone", () => {
  assert.throws(() => applyUpdates(template(), [{ path: "education.degree.year", value: "-5" }]), /between 0 and/);
  assert.throws(() => applyUpdates(template(), [{ path: "compensation.current_benefits.items.vr_brl", value: "-1,5" }]), /between 0 and/);
  assert.equal(applyUpdates(template(), [{ path: "education.degree.year", value: "2020" }]).education.degree.year, 2020);
  assert.equal(applyUpdates(template(), [{ path: "compensation.current_benefits.items.vr_brl", value: "35,5" }]).compensation.current_benefits.items.vr_brl, 35.5);
  assert.equal(applyUpdates(template(), [{ path: "compensation.desired_pj_monthly.us_usd_monthly", value: "4000" }]).compensation.desired_pj_monthly.us_usd_monthly, 4000);
  assert.equal(applyUpdates(template(), [{ path: "education.degree.course", value: "Ciência de Dados 2" }]).education.degree.course, "Ciência de Dados 2");
  assert.equal(applyUpdates(template(), [{ path: "education.degree.course", value: "2020" }]).education.degree.course, "2020", "a text leaf keeps even a numeric-looking string");
  assert.equal(applyUpdates(template(), [{ path: "compensation.current_salary.text_pt", value: "-5" }]).compensation.current_salary.text_pt, "-5");
});

test("runWizard: years_in_data above the known total is refused with the reason and asked again", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "profile.total_years_experience": "3", "profile.years_in_data": ["5", "2"] });
  await runWizard(s.io, file);
  assert.equal(askedFor(s.asked, labelOf("profile.years_in_data")), 2);
  assert.ok(s.said.some((m) => /mais que os 3 anos/.test(m)), s.said.join("|"));
  const bank = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(bank.profile.years_in_data, 2);
  assert.equal(bank.profile.total_years_experience, 3);
});

test("runWizard: years_in_data that never fits the total is skipped after 3 tries, nothing saved", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "profile.total_years_experience": "3", "profile.years_in_data": ["5", "6", "7", "2"] });
  await runWizard(s.io, file);
  assert.equal(askedFor(s.asked, labelOf("profile.years_in_data")), 3);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profile.years_in_data, null);
});

test("runWizard: skill years above the known total are refused and asked again", async () => {
  const file = path.join(freshDir(), "answers.json");
  const s = scripted({ "profile.total_years_experience": "3" }, { skills: "Excel", years: { Excel: ["8", "2"] } });
  await runWizard(s.io, file);
  assert.equal(s.asked.filter((q) => /Há quantos anos você usa Excel/.test(q)).length, 2);
  assert.ok(s.said.some((m) => /mais que os 3 anos/.test(m)), s.said.join("|"));
  const bank = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(bank.skills.find((x: { key: string }) => x.key === "Excel").years, 2);
});
