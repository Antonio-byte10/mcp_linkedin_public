// Run: npx tsx test/formfill.test.ts   (no browser: resolver + planner only; formfill.ts executes the plan in the page)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../src/config.js";
import { loadAnswers } from "../src/answers/bank.js";
import {
  detectLanguage, fieldOfStudy, findSkill, fuzzyOption, jobCountry, normLabel, optionLanguage, orItems, pickResume, questionCountry, resolveAnswer, resolveDetailed, toolLike,
} from "../src/answers/resolver.js";
import { jobLanguage, pickTypeaheadOption, planStep, previewForm, typeaheadHolds, verifyAction, withUnreadableResume, type FillField } from "../src/linkedin/formfillPure.js";
import type { MappedField, MappedStep } from "../src/linkedin/mapperPure.js";
import { fakeAnswers } from "./_fixture-answers.js";

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

const A = fakeAnswers();
const BR = { language: "pt" as const, country: "BR", company: "Umbrella", allowSensitive: true };
const f = (o: Partial<FillField> & { label: string; kind: MappedField["kind"] }): FillField => ({ required: true, ...o });

// --- form maps: every question label ----------------------------------------------------------
// the user's own data folder (never in the repo): real form maps and answers.json
const DATA = resolveDataDir(process.env, os.homedir());
const MAPS = path.join(DATA, "form-maps");

/** Live pages show the account e-mail; the saved maps mask it. Put the fixture's back, as the page would. */
const withFixtureEmail = (xs?: string[]) => xs?.map((o) => (/^\S+@\S+$/.test(o) ? A.profile.email : o));
function loadMaps(): { id: string; steps: MappedStep[] }[] {
  if (!fs.existsSync(MAPS)) return [];
  return fs.readdirSync(MAPS).filter((n) => n.endsWith(".json")).map((n) => {
    const m = JSON.parse(fs.readFileSync(path.join(MAPS, n), "utf8"));
    const steps: MappedStep[] = (m.steps ?? []).map((s: MappedStep) => ({ ...s, fields: s.fields.map((x) => ({ ...x, options: withFixtureEmail(x.options), selected: withFixtureEmail(x.selected) })) }));
    return { id: n.replace(/\.json$/, ""), steps };
  });
}

t("resolver over EVERY question in the data folder's form-maps: every field gets a source or a stated reason", () => {
  const maps = loadMaps();
  if (!maps.length) {
    console.log("  SKIP: no form-maps in the data folder (local only)");
    return;
  }
  const rows: { status: string; label: string; outcome: string }[] = [];
  const problems: string[] = [];
  for (const m of maps) {
    for (const s of m.steps) {
      const plan = planStep(s.fields, A, BR, s.index);
      assert.equal(plan.log.length, s.fields.length, `${m.id} step ${s.index}: one log line per field`);
      plan.log.forEach((l, i) => {
        const L = normLabel(s.fields[i].label);
        const outcome = l.status === "filled" || l.status === "kept" ? (l.source ?? "") : `?${l.reason ?? ""}`;
        if (outcome === "?" || outcome === "") problems.push(`${m.id}: no source/reason for "${L.slice(0, 60)}"`);
        rows.push({ status: l.status, label: L, outcome });
      });
    }
  }
  const resolved = rows.filter((r) => !r.outcome.startsWith("?"));
  const open = rows.filter((r) => r.outcome.startsWith("?"));
  console.log(`  coverage over ${maps.length} maps: ${rows.length} fields -> ${resolved.length} resolved / ${open.length} unanswered or left blank`);
  const seen = new Set<string>();
  for (const r of open) {
    const k = `${r.label.slice(0, 70)} :: ${r.outcome.slice(1)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`    [${r.status}] ${k}`);
  }
  assert.deepEqual(problems, []);
});

t("real answers.json (if present): previews every map without throwing (counts only, no values printed)", () => {
  const real = loadAnswers(path.join(DATA, "answers.json"));
  const maps = loadMaps();
  if (!real || !maps.length) return console.log("  SKIP: no local answers.json / maps");
  let ok = 0;
  let open = 0;
  for (const m of maps) {
    const p = previewForm(m.steps, real, { language: "pt", country: "BR" });
    ok += p.answered.length;
    open += p.unanswered.length;
  }
  console.log(`  real bank: ${ok} answered / ${open} unanswered (sensitive not confirmed in this preview)`);
});

// --- language, country, resume -----------------------------------------------------------------
t("detectLanguage: PT, EN, bilingual, no signal", () => {
  assert.equal(detectLanguage("Analista de Dados Júnior\nBuscamos uma pessoa para atuar com a área de dados e indicadores, com experiência em SQL e Power BI para a empresa."), "pt");
  assert.equal(detectLanguage("Data Analyst\nWe are looking for an analyst to join our team. You will work with the business and build dashboards with SQL and Power BI."), "en");
  assert.equal(
    detectLanguage("Sobre a vaga: buscamos uma pessoa para a área de dados com experiência em SQL e para o time.\nAbout the role: we are looking for an analyst to join our team and you will work with the data in the company."),
    "bilingual",
  );
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("Power BI SQL"), null);
  // I2: a title alone is too little signal to choose a resume.
  assert.equal(detectLanguage("Analista de Dados"), null);
  assert.equal(detectLanguage("Data Analyst for the BI team"), null);
  assert.equal(jobLanguage({ title: "Analista de Dados", description: null }), null);
  assert.equal(jobLanguage({ title: "Analista de Dados", description: "Vaga para analista." }), null); // too short to be a real description
  assert.equal(jobLanguage({ title: "Analista", description: "Buscamos uma pessoa para atuar com a área de dados e indicadores, com experiência em SQL e Power BI para a empresa e para o time." }), "pt");
});

t("jobCountry: Brazilian locations, foreign ones, unknown", () => {
  assert.equal(jobCountry("Campinas, SP (Híbrido)"), "BR");
  assert.equal(jobCountry("São Paulo, São Paulo, Brasil (Remoto)"), "BR");
  assert.equal(jobCountry("Brasil (Remoto)"), "BR");
  assert.equal(jobCountry("Lisboa, Portugal"), "PT");
  assert.equal(jobCountry("Philadelphia, PA"), null); // PA is also a US state: not assumed Brazil
  assert.equal(jobCountry("Austin, Texas, United States"), "US");
  assert.equal(jobCountry("(Remoto)"), null);
  assert.equal(jobCountry(null), null);
});

t("resume choice follows the job language", () => {
  const opts = ["PDF cv-fake-en.pdf 01/01/2026", "PDF cv-fake-pt.pdf 01/01/2026"];
  assert.equal(pickResume(opts, [opts[0]], A, "pt").res?.value, opts[1]);
  assert.equal(pickResume(opts, [opts[1]], A, "en").res?.value, opts[0]);
  assert.equal(pickResume(opts, [opts[1]], A, "bilingual").res?.value, opts[0]); // bilingual -> resume_by_language.bilingual = en
  assert.equal(pickResume(opts, [opts[0]], A, null).reason, "unknown_job_language");
  // No option holds the bank file name: the preselected one stays only if it is in the job language.
  const other = ["PDF Resume_EN.pdf 01/01/2026", "PDF CV_PT.pdf 01/01/2026"];
  assert.equal(pickResume(other, [other[1]], A, "pt").res?.value, other[1]);
  assert.equal(pickResume(other, [other[0]], A, "pt").res, null);
  assert.equal(pickResume(other, [], A, "en").res, null);
  assert.equal(optionLanguage("PDF Resume_EN.pdf"), "en");
  assert.equal(optionLanguage("PDF CV_PT.pdf"), "pt");
  assert.equal(optionLanguage("PDF cv.pdf"), null);
  // through the resolver: unlabeled options are never picked by position
  assert.equal(resolveDetailed("Currículo*", "radio", ["on", "on"], A, { ctx: BR, selected: ["on"] }).reason, "unlabeled_options");
});

// --- options, skills ---------------------------------------------------------------------------
t("fuzzy select: accent/case-insensitive, whole word, ambiguity and placeholder", () => {
  const o = ["Selecionar opção", "Básico", "Intermediário", "Avançado", "Fluente"];
  assert.equal(fuzzyOption(o, "avancado"), "Avançado");
  assert.equal(fuzzyOption(o, "FLUENTE"), "Fluente");
  assert.equal(fuzzyOption(["Brasil (+55)", "Brasilândia (+1)"], "Brasil (+55)"), "Brasil (+55)");
  assert.equal(fuzzyOption(["Sim, autorizo", "Não, não autorizo"], "autorizo"), null); // two whole-word hits
  assert.equal(fuzzyOption(o, "selecionar opcao"), null); // placeholder never chosen
  assert.equal(fuzzyOption(o, "nativo"), null);
});

t("findSkill: aliases, longest alias wins, unlisted", () => {
  const s = (p: string) => { const r = findSkill(p, A); return typeof r === "string" ? r : r?.key ?? null; };
  assert.equal(s("Microsoft Excel"), "excel");
  assert.equal(s("Excel Dashboards"), "excel_dashboards");
  assert.equal(s("Artificial Intelligence (AI)"), "ai");
  assert.equal(s("Análise de pessoas"), "people_analytics");
  assert.equal(s("SQL Server"), "partial"); // M9: an extra unknown term is a different thing
  assert.equal(s("Python and SQL"), "ambiguous"); // M9: two bank skills, one answer cannot fit both
  assert.equal(s("Python e Django"), "partial");
  assert.equal(s("ferramentas Power BI"), "power_bi"); // filler words are fine
  assert.equal(s("Sales"), null);
  assert.equal(s("Business Consulting and Services"), null); // "ai" never matches inside words
});

t("regex families PT + EN", () => {
  const r = (label: string, kind: MappedField["kind"], options?: string[], ctx = BR) => resolveAnswer(label, kind, options, A, { ctx });
  assert.equal(r("Há quantos anos você já usa Python no trabalho?", "text")?.value, "2");
  assert.equal(r("How many years of experience do you have with SQL?", "number")?.value, "2");
  assert.equal(r("Quantos anos de experiência com Tableau?", "text")?.value, "0"); // unlisted -> policy 0
  assert.equal(r("Quantos anos de experiência com Tableau?", "text")?.policy, true);
  assert.equal(r("Years of professional experience", "text")?.value, "3");
  assert.equal(r("Você tem conhecimento de Power BI?*", "radio", ["Sim", "Não"])?.value, "Sim");
  assert.equal(r("Do you have experience with Tableau?", "radio", ["Yes", "No"])?.value, "No");
  assert.equal(r("Are you willing to relocate?", "select", ["Select an option", "Yes", "No"])?.value, "Yes");
  assert.equal(r("Are you comfortable working on-site?", "radio", ["Yes", "No"])?.value, "No");
  assert.equal(r("Will you now or in the future require visa sponsorship?", "radio", ["Yes", "No"])?.value, "No");
  assert.equal(r("Will you now or in the future require visa sponsorship?", "radio", ["Yes", "No"], { ...BR, country: "US" })?.value, "Yes");
  assert.equal(r("Are you legally authorized to work in this country?", "radio", ["Yes", "No"], { ...BR, country: "US" })?.value, "No");
  assert.equal(r("Are you legally authorized to work in this country?", "radio", ["Yes", "No"], { ...BR, country: "DE" })?.value, "Yes"); // EU
  assert.equal(r("Qual seu nível de inglês?", "select", ["Básico", "Intermediário", "Avançado", "Fluente"])?.value, "Avançado");
  assert.equal(r("What is your level of proficiency in Spanish?", "select", ["None", "Conversational", "Professional", "Native or bilingual"])?.value, "Conversational");
  assert.equal(r("Qual seu aviso prévio (dias)?", "number")?.value, "30");
  assert.equal(r("Você aceita contratação CLT?", "radio", ["Sim", "Não"])?.value, "Sim");
  assert.equal(r("Pessoa com deficiência (PcD)?", "select", ["Sim", "Não", "Prefiro não informar"])?.value, "Prefiro não informar");
  assert.equal(r("Como você soube da vaga?", "select", ["Indicação", "LinkedIn", "Site"])?.value, "LinkedIn");
  assert.equal(r("Have you completed the following level of education: Bachelor's Degree?", "radio", ["Yes", "No"])?.value, "No");
  assert.equal(r("Have you completed the following level of education: Technologist?", "radio", ["Yes", "No"])?.value, "Yes");
  assert.deepEqual(r("Você conhece alguém que trabalha aqui?", "checkbox_group", ["Não conheço", "Sim, um amigo"])?.value, ["Não conheço"]);
  assert.equal(r("Você trabalha atualmente na Acme Fake Ltda?", "radio", ["Sim", "Não"])?.value, "Sim");
  assert.equal(r("Pretensão salarial mínima", "number")?.value, "5000");
});

t("no invention: unknown questions, null bank values, unknown country, refused consents => null", () => {
  for (const q of ["Qual a cor do seu carro?", "Describe your biggest weakness", "Você tem CNH categoria B?", "zxqv lorem ipsum 42", "Qual o nome da sua mãe?", "Why do you want to work here?"]) {
    for (const kind of ["text", "radio", "select", "checkbox_group"] as const) {
      assert.equal(resolveAnswer(q, kind, ["Sim", "Não", "Yes", "No"], A, { ctx: BR }), null, `${q} (${kind})`);
    }
  }
  const noCountry = { ...BR, country: null };
  assert.equal(resolveAnswer("Are you legally authorized to work in this country?", "radio", ["Yes", "No"], A, { ctx: noCountry }), null);
  assert.equal(resolveAnswer("Por favor insira o salário desejado", "text", [], A, { ctx: noCountry }), null);
  assert.equal(resolveAnswer("Desired salary (USD)", "text", [], A, { ctx: BR }), null);
  const b = fakeAnswers();
  b.consents.ai_screening = false;
  b.skills[0].knows = null;
  b.diversity.gender = null;
  assert.equal(resolveAnswer("Autoriza o uso de inteligência artificial (IA) na triagem do processo seletivo?", "select", ["Sim, autorizo", "Não, não autorizo"], b, { ctx: BR }), null);
  assert.equal(resolveAnswer("Você tem conhecimento de Excel?", "radio", ["Sim", "Não"], b, { ctx: BR }), null);
  assert.equal(resolveAnswer("Gênero", "select", ["Feminino", "Masculino", "Prefiro não responder"], b, { ctx: BR }), null);
  // Required group with no "none"-like truth: the user has certifications, just none of these.
  assert.equal(resolveAnswer("Você possui alguma certificação?", "checkbox_group", ["CERTIFICADO CPA10", "NÃO POSSUI"], A, { ctx: BR }), null);
  const nocert = fakeAnswers();
  nocert.education.certifications = [];
  assert.deepEqual(resolveAnswer("Você possui alguma certificação?", "checkbox_group", ["CERTIFICADO CPA10", "NÃO POSSUI"], nocert, { ctx: BR })?.value, ["NÃO POSSUI"]);
  assert.equal(resolveAnswer("x", "text", [], null), null);
});

t("two families disagreeing => null (conflict)", () => {
  const b = fakeAnswers();
  b.consents.privacy_lgpd = true;
  b.consents.ai_screening = false;
  const d = resolveDetailed("Autorizo o tratamento de dados pessoais (LGPD) e o uso de inteligência artificial (IA) na triagem", "select", ["Sim", "Não"], b, { ctx: BR });
  assert.equal(d.res, null);
  const d2 = resolveDetailed("Are you comfortable working remote or hybrid?", "radio", ["Yes", "No"], A, { ctx: BR });
  assert.equal(d2.res, null);
});

t("approved alias (learned[]) answers before the regex families", () => {
  const b = fakeAnswers();
  b.learned = [{ label_norm: "Você tem CNH categoria B?", kind: "radio", answer: "Sim" }];
  const r = resolveAnswer("Você tem CNH categoria B?*", "radio", ["Sim", "Não"], b, { ctx: BR });
  assert.equal(r?.value, "Sim");
  assert.equal(r?.source, "learned");
  assert.equal(resolveAnswer("Você tem CNH categoria B?*", "text", [], b, { ctx: BR }), null); // kind differs
});

// --- prefill and planning ----------------------------------------------------------------------
t("prefilled years: no bank entry => unanswered; bank entry differs => overwrite; equal => keep", () => {
  const p = planStep(
    [
      f({ label: "How many years of Sales experience do you currently have?", kind: "text", prefilled: "0" }),
      f({ label: "How many years of Sales experience do you currently have?", kind: "text", required: false, prefilled: "5" }),
      f({ label: "Há quantos anos você já usa Microsoft Excel no trabalho?", kind: "text", prefilled: "7" }),
      f({ label: "Há quantos anos você já usa Python no trabalho?", kind: "text", prefilled: "2" }),
      f({ label: "How many years of Tableau experience do you currently have?", kind: "text" }),
    ],
    A, BR,
  );
  assert.equal(p.ok, false);
  assert.deepEqual(p.unanswered.map((u) => u.reason), ["prefilled_without_bank_entry (policy.skills_not_listed)"]);
  assert.deepEqual(p.log.map((l) => l.status), ["unanswered", "kept", "filled", "kept", "filled"]);
  assert.equal(p.log[2].reason, "overwrote_prefill");
  assert.deepEqual(p.actions.map((a) => [a.op, a.value]), [["fill", "2"], ["fill", "0"]]);
});

t("fill planning: one action per kind, nothing for kept fields, nothing at all when a required field is open", () => {
  const fields: FillField[] = [
    f({ ref: 0, label: "First name*", kind: "text", key: "FIRST_NAME", prefilled: "Fulano" }),
    f({ ref: 1, label: "Código do país*", kind: "select", options: ["Andorra (+376)", "Brasil (+55)"], selected: ["Andorra (+376)"] }),
    f({ ref: 2, label: "Phone*", kind: "tel", key: "PHONE_MOBILE", prefilled: "(11) 90000-0000" }),
    f({ ref: 3, label: "Location (city)*", kind: "typeahead" }),
    f({ ref: 4, label: "Você está disposto(a) para realocação?*", kind: "radio", options: ["Sim", "Não"], selected: [] }),
    f({ ref: 5, label: "Considerando que nosso modelo de trabalho é presencial, em qual escritório você tem interesse?*", kind: "checkbox_group", options: ["Não tenho interesse em trabalhar presencialmente", "Sim, São Paulo"], selected: ["Sim, São Paulo"] }),
    f({ ref: 6, label: "Certifico que as informações estão corretas.*", kind: "checkbox", options: ["Confirmado"], selected: [] }),
    f({ ref: 7, label: "Qual seu nível de fluência na língua inglesa?*", kind: "select", options: ["Selecionar opção", "Básico", "Avançado"], selected: ["Selecionar opção"] }),
    f({ ref: 8, label: "Cover letter", kind: "file", required: false }),
  ];
  const p = planStep(fields, A, BR, 2);
  assert.equal(p.ok, true);
  assert.deepEqual(
    p.actions.map((a) => [a.ref, a.op, a.value]),
    [
      [1, "select", "Brasil (+55)"],
      [3, "typeahead", "Cidade Teste"],
      [4, "check", ["Sim"]],
      [5, "check", ["Não tenho interesse em trabalhar presencialmente"]],
      [6, "toggle", true],
      [7, "select", "Avançado"],
    ],
  );
  assert.deepEqual(p.log.map((l) => l.status), ["kept", "filled", "kept", "filled", "filled", "filled", "filled", "filled", "left_blank"]);
  // One unanswerable required field => no action at all (the dialog is discarded untouched).
  const q = planStep([...fields, f({ ref: 9, label: "Qual a sua cor favorita?*", kind: "text" })], A, BR, 2);
  assert.equal(q.ok, false);
  assert.equal(q.unanswered[0].reason, "no_rule");
});

t("sensitive answers need the one-time confirmation; logs never carry personal values", () => {
  const fields = [f({ label: "CPF", kind: "text" }), f({ label: "Informe seu salário atual/último:", kind: "text" }), f({ label: "First name*", kind: "text", key: "FIRST_NAME" }), f({ label: "Phone*", kind: "tel", key: "PHONE_MOBILE" })];
  const no = planStep(fields, A, { ...BR, allowSensitive: false });
  assert.deepEqual(no.unanswered.map((u) => u.reason), ["sensitive_needs_confirmation:profile.cpf", "sensitive_needs_confirmation:compensation.current_salary.text_pt"]);
  const yes = planStep(fields, A, BR);
  assert.equal(yes.ok, true);
  const logText = JSON.stringify(yes.log);
  for (const secret of [A.profile.cpf, A.compensation.current_salary.text_pt, A.profile.first_name, A.profile.phone.national]) assert.ok(!logText.includes(secret), "value leaked into the log");
  assert.ok(yes.log.every((l) => l.value === "***" && l.source));
});

t("conditional 'Se sim...' is NA only after a No on the previous question", () => {
  const prev = (ans: string[]) => [
    f({ label: "Você trabalha atualmente na Umbrella?*", kind: "select", options: ["Selecionar opção", "Sim, trabalho na Umbrella", "Não, não trabalho na Umbrella"], selected: ans }),
    f({ label: "Se sim para pergunta anterior, qual é o nome completo do colaborador?", kind: "text", conditional: true }),
  ];
  const p = planStep(prev([]), A, BR);
  assert.deepEqual(p.actions.map((a) => a.value), ["Não, não trabalho na Umbrella", "NA"]);
  const b = fakeAnswers();
  b.profile.current_employer = "Umbrella";
  const q = planStep(prev([]), b, BR);
  assert.equal(q.ok, false); // answered Sim -> the follow-up needs the user
  assert.equal(q.unanswered[0].reason, "conditional_on_unknown_answer");
});

t("read-back verification and typeahead pick", () => {
  assert.equal(verifyAction({ op: "fill", label: "Phone", kind: "tel", value: "11900000000" }, f({ label: "Phone", kind: "tel", prefilled: "(11) 90000-0000" })), true);
  assert.equal(verifyAction({ op: "fill", label: "Years", kind: "text", value: "2" }, f({ label: "Years", kind: "text", prefilled: "20" })), false);
  assert.equal(verifyAction({ op: "select", label: "L", kind: "select", value: "Avançado" }, f({ label: "L", kind: "select", selected: ["Avançado"] })), true);
  assert.equal(verifyAction({ op: "check", label: "R", kind: "radio", value: ["Sim"] }, f({ label: "R", kind: "radio", selected: [] })), false);
  assert.equal(verifyAction({ op: "check", label: "G", kind: "checkbox_group", value: ["A"] }, f({ label: "G", kind: "checkbox_group", selected: ["A", "B"] })), false);
  assert.equal(verifyAction({ op: "toggle", label: "C", kind: "checkbox", value: true }, f({ label: "C", kind: "checkbox", selected: ["checked"] })), true);
  assert.equal(verifyAction({ op: "fill", label: "X", kind: "text", value: "a" }, undefined), false);
  const sug = ["Cidade Teste, São Paulo, Brasil", "Cidade Teste Nova, Paraná, Brasil", "Outra, Bahia, Brasil"];
  assert.equal(pickTypeaheadOption(sug, [A.profile.location_city.pt], "Cidade Teste"), 0);
  assert.equal(pickTypeaheadOption(["Cidade Teste, SP", "Cidade Teste, RJ"], ["Cidade Teste, Minas Gerais, Brasil"], "Cidade Teste"), null); // two candidates: never the first
  assert.equal(pickTypeaheadOption(["Outra, Bahia, Brasil"], [A.profile.location_city.pt], "Cidade Teste"), null);
});

// --- final review (T6) ---------------------------------------------------------------------------
t("C1 work authorization / sponsorship use the country the QUESTION names", () => {
  const yn = ["Yes", "No"];
  const d = (label: string, ctx: typeof BR | (Omit<typeof BR, "country"> & { country: string | null }) = BR) => resolveDetailed(label, "radio", yn, A, { ctx });
  assert.equal(d("Are you legally authorized to work in the United States?").res, null); // BR job, US question
  assert.match(d("Are you legally authorized to work in the United States?").reason!, /question_country_US_differs_from_job_BR/);
  assert.equal(d("Are you legally authorized to work in the United States?", { ...BR, country: "US" }).res?.value, "No");
  assert.equal(d("Are you legally authorized to work in the US?", { ...BR, country: null }).res?.value, "No"); // named, job country unknown
  assert.equal(d("Are you authorized to work in Brazil?").res?.value, "Yes");
  assert.equal(resolveAnswer("Você está autorizado a trabalhar no Brasil?", "radio", ["Sim", "Não"], A, { ctx: BR })?.value, "Sim");
  assert.equal(d("Are you legally authorized to work in Singapore?").reason, "question_country_unknown");
  assert.equal(d("Are you legally authorized to work in this country?").res?.value, "Yes");
  assert.equal(d("Are you authorized to work in the European Union?", { ...BR, country: "DE" }).res?.value, "Yes");
  assert.equal(d("Will you require visa sponsorship to work in the US?").res, null); // BR job
  assert.equal(d("Will you require visa sponsorship to work in the US?", { ...BR, country: "US" }).res?.value, "Yes");
  assert.deepEqual(questionCountry("voce esta legalmente autorizado(a) a trabalhar no pais para o qual esta se candidatando"), { named: false, country: null });
});

t("C2 skills_not_listed only for tool-like phrases; roles, industries and soft skills stay unanswered", () => {
  for (const q of [
    "How many years of experience do you have in the IT industry?",
    "How many years of experience do you have in a similar role?",
    "Quantos anos de experiência com gestão de equipes?",
    "How many years of stakeholder management experience do you currently have?",
    "How many years of Food and Beverage Services experience do you currently have?",
    "Do you have experience with team leadership?",
    "Você tem experiência com atendimento a clientes?",
  ]) {
    const kind = /^(do|voc)/i.test(q) ? "radio" : "text";
    const d = resolveDetailed(q, kind, ["Sim", "Não", "Yes", "No"], A, { ctx: BR });
    assert.equal(d.res, null, q);
    assert.equal(d.reason, "skill_not_in_bank", q);
  }
  assert.equal(resolveAnswer("How many years of Tableau experience do you currently have?", "text", [], A, { ctx: BR })?.value, "0");
  assert.equal(resolveAnswer("Do you have experience with Looker?", "radio", ["Yes", "No"], A, { ctx: BR })?.value, "No");
  assert.equal(toolLike("Account Planning"), true);
  assert.equal(toolLike("the IT industry"), false);
});

t("M9 two skills / unknown extra term in one question => unanswered", () => {
  assert.equal(resolveDetailed("How many years of experience do you have with Python and SQL?", "text", [], A, { ctx: BR }).reason, "several_skills_in_one_question");
  assert.equal(resolveDetailed("Você tem conhecimento de Python e Django?", "radio", ["Sim", "Não"], A, { ctx: BR }).reason, "unknown_term_in_skill_question");
  assert.equal(resolveDetailed("How many years of experience do you have with SQL Server?", "text", [], A, { ctx: BR }).reason, "unknown_term_in_skill_question");
});

t("I1 a named field of study must match the bank's course", () => {
  const b = fakeAnswers();
  b.education.degree.course = "Tecnologia em Banco de Dados";
  b.education.levels_completed = ["technologist", "bachelor"];
  const yn = ["Yes", "No"];
  assert.equal(fieldOfStudy("have you completed a bachelor's degree in computer science"), "computer science");
  assert.equal(fieldOfStudy("have you completed the following level of education: master of business administration"), null);
  assert.equal(resolveDetailed("Have you completed a Bachelor's degree in Computer Science?", "radio", yn, b, { ctx: BR }).reason, "field_of_study_not_in_bank");
  assert.equal(resolveDetailed("Você possui graduação em Administração?", "radio", ["Sim", "Não"], b, { ctx: BR }).reason, "field_of_study_not_in_bank");
  assert.equal(resolveAnswer("Have you completed a Technologist degree in Banco de Dados?", "radio", yn, b, { ctx: BR })?.value, "Yes");
  assert.equal(resolveAnswer("Have you completed the following level of education: Bachelor's Degree?", "radio", yn, b, { ctx: BR })?.value, "Yes"); // no field named
  const noCourse = fakeAnswers();
  assert.equal(resolveDetailed("Have you completed a Bachelor's degree in Computer Science?", "radio", yn, noCourse, { ctx: BR }).reason, "no_bank_value:education.degree.course");
});

t("I5 diversity answers are sensitive: gated by the confirmation and masked in the log", () => {
  const fields = [f({ label: "Gênero", kind: "select", options: ["Selecionar opção", "Feminino", "Masculino", "Prefiro não informar"], selected: [] })];
  const no = planStep(fields, A, { ...BR, allowSensitive: false });
  assert.equal(no.ok, false);
  assert.equal(no.unanswered[0].reason, "sensitive_needs_confirmation:diversity.gender");
  const yes = planStep(fields, A, BR);
  assert.equal(yes.ok, true);
  assert.equal(yes.log[0].value, "***");
  assert.deepEqual(yes.actions.map((a) => a.value), ["Prefiro não informar"]);
});

t("M10 desired salary: PJ in the label or hint uses the PJ figure; CLT and PJ together => unanswered", () => {
  const b = fakeAnswers();
  b.compensation.desired_pj_monthly.brazil_brl_min = 9000;
  const r = (label: string, hint?: string) => resolveDetailed(label, "number", [], b, { ctx: BR, hint });
  assert.equal(r("Pretensão salarial").res?.value, "6000");
  assert.equal(r("Pretensão salarial (PJ)").res?.value, "9000");
  assert.equal(r("Pretensão salarial", "Valor mensal como pessoa jurídica").res?.value, "9000");
  assert.equal(r("Pretensão salarial CLT ou PJ").reason, "clt_and_pj_in_one_question");
  assert.equal(r("Desired salary", "Amount in USD").reason, "non_brl_currency");
  // the planner passes hint + placeholder through
  const p = planStep([f({ label: "Pretensão salarial", kind: "number", placeholder: "Valor PJ mensal" })], b, BR);
  assert.deepEqual(p.actions.map((a) => a.value), ["9000"]);
});

t("M1 typeahead: keep-check and read-back use the same test; a bare typed query is never 'held'", () => {
  const tg = [A.profile.location_city.pt];
  assert.equal(typeaheadHolds("Cidade Teste, São Paulo, Brasil", tg), true);
  assert.equal(typeaheadHolds("Cidade Teste", tg), false); // typed, never picked
  assert.equal(typeaheadHolds("Cidade Teste, São Paulo", tg), true); // a complete suggestion inside the target
  const kept = planStep([f({ label: "Location (city)*", kind: "typeahead", prefilled: "Cidade Teste, São Paulo, Brasil" })], A, BR);
  assert.equal(kept.actions.length, 0);
  const typed = planStep([f({ label: "Location (city)*", kind: "typeahead", prefilled: "Cidade Teste" })], A, BR);
  assert.equal(typed.actions[0]?.op, "typeahead");
  const act = typed.actions[0];
  assert.equal(verifyAction(act, f({ label: "Location (city)*", kind: "typeahead", prefilled: "Cidade Teste" })), false);
  assert.equal(verifyAction(act, f({ label: "Location (city)*", kind: "typeahead", prefilled: "Cidade Teste, São Paulo, Brasil" })), true);
});

t("modality: N days/x a week in the office is hybrid, only inside target.hybrid_area; full on-site stays on-site", () => {
  const B = structuredClone(A);
  B.target.hybrid_area = ["São Paulo, SP", "São Paulo, São Paulo", "Campinas"];
  B.mobility.accepts_hybrid = true;
  B.mobility.accepts_onsite = false;
  const yn = ["Yes", "No"];
  const sp = { ...BR, location: "São Paulo, São Paulo, Brasil" };
  const q = (label: string, ctx: object = sp) => resolveDetailed(label, "radio", yn, B, { ctx });
  assert.deepEqual([q("Tem disponibilidade para atuar presencialmente 3x por semana na Vila Olímpia, São Paulo/SP?").res?.value, q("Tem disponibilidade para atuar presencialmente 3x por semana na Vila Olímpia, São Paulo/SP?").res?.source], ["Yes", "mobility.accepts_hybrid"]);
  assert.equal(q("Are you available to work on-site three days a week?").res?.value, "Yes");
  assert.equal(q("Você aceita trabalhar presencialmente 2 dias na semana em Campinas?", { ...BR, location: "Brasil" }).res?.value, "Yes"); // place named in the question
  assert.equal(q("Tem disponibilidade para atuar presencialmente 2x por semana em Curitiba?", { ...BR, location: "Curitiba, PR" }).reason, "hybrid_outside_hybrid_area");
  assert.deepEqual([q("Tem disponibilidade para trabalhar presencialmente em São Paulo?").res?.value, q("Tem disponibilidade para trabalhar presencialmente em São Paulo?").res?.source], ["No", "mobility.accepts_onsite"]);
  // a template placeholder is not an area: no area check
  B.target.hybrid_area = ["<cidade>"];
  assert.equal(q("Tem disponibilidade para atuar presencialmente 2x por semana em Curitiba?", { ...BR, location: "Curitiba, PR" }).res?.value, "Yes");
});

t("learned[]: a salary / CPF question answered there is still sensitive (needs confirm_sensitive, masked)", () => {
  const B = structuredClone(A);
  B.learned = [
    { label_norm: "a partir de qual valor esta sua pretensao salarial", kind: "text", answer: "6000" },
    { label_norm: "voce possui experiencia profissional utilizando python para projetos de dados", kind: "radio", answer: "Yes" },
  ];
  const sal = resolveDetailed("A partir de qual valor está sua pretensão salarial?", "text", [], B, { ctx: BR });
  assert.deepEqual([sal.res?.value, sal.res?.source, sal.res?.sensitive], ["6000", "learned", true]);
  const py = resolveDetailed("Você possui experiência profissional utilizando Python para projetos de dados?*", "radio", ["Yes", "No"], B, { ctx: BR });
  assert.deepEqual([py.res?.value, py.res?.source, py.res?.sensitive], ["Yes", "learned", undefined]);
  const p = previewForm([{ index: 0, progress: "", section: "", buttons: [], errors: [], fields: [f({ label: "A partir de qual valor está sua pretensão salarial?", kind: "text" })] }], B, { language: "pt", country: "BR" });
  assert.match(p.unanswered[0]?.reason ?? "", /^sensitive_needs_confirmation:learned/);
});

t("previewForm: an unanswered question carries the learned[] key (label_norm) and its options", () => {
  const label = "Você possui experiência profissional utilizando Python para desenvolvimento de soluções de dados?*";
  const p = previewForm([{ index: 0, progress: "", section: "", buttons: [], errors: [], fields: [f({ label, kind: "radio", options: ["Yes", "No"] })] }], A, { language: "pt", country: "BR" });
  assert.equal(p.unanswered[0].label_norm, normLabel(label));
  assert.deepEqual(p.unanswered[0].options, ["Yes", "No"]);
  // the key really works: the same question is answered once it is in learned[]
  const B = structuredClone(A);
  B.learned = [{ label_norm: p.unanswered[0].label_norm, kind: "radio", answer: "Yes" }];
  assert.equal(previewForm([{ index: 0, progress: "", section: "", buttons: [], errors: [], fields: [f({ label, kind: "radio", options: ["Yes", "No"] })] }], B, { language: "pt", country: "BR" }).ok, true);
});

t("0.8.0 rules from the later mapped forms (portable: no data folder needed)", () => {
  const yn = ["Yes", "No"];
  const d = (label: string, kind: MappedField["kind"], options: string[] = [], ctx: object = BR) => resolveDetailed(label, kind, options, A, { ctx });
  // LinkedIn's language scale in the PT UI
  const ptScale = ["Selecionar opção", "Nenhuma", "Conversação", "Proficiente", "Nativo ou bilíngue"];
  assert.equal(d("Qual seu nível de proficiência em Inglês?*", "select", ptScale).res?.value, "Proficiente");
  assert.equal(d("Qual seu nível de proficiência em Espanhol?*", "select", ptScale).res?.value, "Conversação");
  // OR lists: none of the listed tools in the bank = 0 / No; any one known = Yes
  assert.equal(orItems("tableau or looker or qlik")?.length, 3);
  assert.equal(orItems("python and sql"), null); // "and" never splits
  assert.equal(d("For how many years have you been working with Tableau or Looker or Qlik?", "text").res?.value, "0");
  assert.equal(d("Are you proficient in one of the following: SQL, Python, or R?*", "radio", yn).res?.value, "Yes");
  assert.equal(d("Você possui experiência e conhecimento com Power BI ou Looker Studio (Google Data Studio)?*", "radio", yn).res?.value, "Yes");
  assert.equal(d("Do you have experience with Tableau or Looker?", "radio", yn).res?.value, "No");
  assert.equal(d("How many years of experience do you have with Python or R?", "text").res, null); // one known, one not: no single number
  assert.equal(d("Quantos anos de experiência com Power BI você tem?", "text").res?.value, "2"); // trailing "você tem" is not a skill word
  // current salary, on-site "trabalharia", hybrid office, residence
  assert.equal(d("Qual seu último ou atual salário?", "text").res?.source, "compensation.current_salary.text_pt");
  assert.equal(d("Você trabalharia presencialmente?*", "radio", ["Sim", "Não"]).res?.value, "Não");
  assert.equal(d("Reside em Exemplópolis ou Região Metropolitana, e tem disponibilidade de trabalhar híbrido no Escritório Regional?*", "radio", yn).reason, "residence_in_question");
  // employee relationship / employer group / country of residence / associate's degree
  assert.equal(d("Do you as a candidate have a personal relationship with a current Acme employee?*", "radio", yn).res?.value, "No");
  assert.equal(d("Are you presently employed by any company within the Acme group?*", "radio", yn).res?.value, "No");
  assert.equal(d("In which country/region are you currently based?*", "select", ["Selecionar opção", "Argentina", "Brazil", "Chile"]).res?.value, "Brazil");
  assert.equal(d("In which country/region are you currently based?*", "select", ["Selecionar opção", "Argentina", "… (198 options total)"]).reason, "option_not_in_truncated_map:profile.location_city");
  const tech = structuredClone(A);
  tech.education.higher_ed_status = "technologist_complete";
  assert.equal(resolveAnswer("Degree*", "select", ["Selecionar opção", "High School", "Associate's Degree", "Bachelor's Degree"], tech, { ctx: BR })?.value, "Associate's Degree");
});

t("open question: a resume section with no readable control stops the step", () => {
  const other = [f({ label: "Phone*", kind: "tel", key: "PHONE_MOBILE", prefilled: "11900000000" })];
  const plan = planStep(withUnreadableResume(other, true), A, BR);
  assert.equal(plan.ok, false);
  assert.equal(plan.unanswered[0].reason, "unknown_field_kind");
  assert.equal(withUnreadableResume(other, false).length, 1);
  const radio = [f({ label: "Currículo*", kind: "radio", options: ["PDF cv-fake-pt.pdf"], selected: [] })];
  assert.equal(withUnreadableResume(radio, true).length, 1); // a readable resume radio: nothing added
});

t("open question: the filler reads a control's label only from its own label/aria/legend", () => {
  // In-page code cannot run here: check the input path no longer borrows neighbouring text.
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", "dialog.ts"), "utf8"); // the shared reader (fill mode)
  const line = src.split("\n").find((l) => l.includes("const fillLabel = labelOf(el)"));
  assert.ok(line && !/precedingText|innerText/.test(line), line ?? "fillLabel line not found");
  // and fill mode uses exactly that label (the mapper's neighbour-text fallback stays on the other branch)
  assert.ok(/const label = fill\s*\?\s*fillLabel\s*:/.test(src), "fill mode must use fillLabel");
  // and an unlabeled required control is unanswered, never filled
  const p = planStep([f({ label: "", kind: "text" })], A, BR);
  assert.equal(p.ok, false);
  assert.equal(p.unanswered[0].reason, "no_rule");
});

if (failed) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall formfill tests passed");
