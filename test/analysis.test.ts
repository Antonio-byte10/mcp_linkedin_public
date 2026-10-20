// Run: npx tsx test/analysis.test.ts   (pure functions + temp files only: no browser, no real DB/answers.json)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeJob, inferArea, inferSeniority, loadTargetSeniority, loadUserSkills, offerableForApply, safeReqs } from "../src/analysis/match.js";
import { analyzeSkills, skillsInText } from "../src/analysis/skills.js";
import { fitsJobPage, fitsPreferences, loadAnswers, loadTarget, type Target } from "../src/answers/bank.js";
import type { JobRow } from "../src/store/db.js";

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
const has = (text: string, ...skills: string[]) => {
  const got = skillsInText(text);
  for (const s of skills) assert.ok(got.includes(s), `expected ${s} in [${got}] for ${JSON.stringify(text)}`);
};
const lacks = (text: string, ...skills: string[]) => {
  const got = skillsInText(text);
  for (const s of skills) assert.ok(!got.includes(s), `unexpected ${s} in [${got}] for ${JSON.stringify(text)}`);
};
const job = (o: Partial<JobRow>): JobRow => ({ id: "1", title: null, company: null, location: null, url: null, easy_apply: null, posted: null, description: null, applied: 0, closed: 0, apply_url: null, tracker_seen: 0, enriched_at: null, modality: null, employment_type: null, applicants: null, requirements: null, company_url: null, search_keywords: null, first_seen: null, posted_at: null, enrich_attempts: 0, enrich_failed_at: null, ...o });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-analysis-"));
const write = (name: string, body: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };

// --- C1 safeReqs ------------------------------------------------------------------------
t("safeReqs: bad JSON / object / null items never throw", () => {
  assert.deepEqual(safeReqs({ requirements: "not json" }), []);
  assert.deepEqual(safeReqs({ requirements: '{"a":1}' }), []);
  assert.deepEqual(safeReqs({ requirements: '[null,5,"SQL","  "]' }), ["SQL"]);
  assert.deepEqual(safeReqs({ requirements: null }), []);
  const a = analyzeJob(job({ title: "Analista de Dados", requirements: "not json" }), new Set(), new Set());
  assert.equal(a.analyzed_from, "Só título");
});

// --- I2 normalisation -------------------------------------------------------------------
t("whitespace / hyphen / NBSP variants", () => {
  has("Power  BI", "Power BI");
  has("Power-BI", "Power BI");
  has("power\tbi", "Power BI");
  has("Power\nBI avançado", "Power BI");
  has("Power BI", "Power BI");
  has("T-SQL e Python3", "SQL", "Python");
  has("SQL2019", "SQL");
  has("scikit-learn", "Machine Learning");
});

// --- I3 dictionary gaps ----------------------------------------------------------------
t("dictionary gaps", () => {
  has("Experiência com C# e .NET", "C#", ".NET");
  has("C++ moderno", "C++");
  has("Golang developer", "Go");
  has("Docker, Kubernetes, Kafka e Hadoop", "Docker", "Kubernetes", "Kafka", "Hadoop");
  has("MongoDB ou NoSQL", "NoSQL");
  has("SSIS/SSRS, Talend, Pentaho, Fivetran, Metabase", "SSIS / SSRS", "Talend", "Pentaho", "Fivetran", "Metabase");
  has("LangChain, NLP, deep learning, Copilot", "LangChain", "NLP", "Deep Learning", "Copilot");
  has("Data Lake e Lakehouse", "Data Lake");
  has("Google Sheets e SharePoint", "Google Sheets", "SharePoint");
  has("Conhecimento em IA", "IA / LLMs");
  has("Experiência com I.A. generativa", "IA / LLMs");
  has("Inglês bilíngue", "Inglês");
  has("Inglês bilingue", "Inglês");
  has("Java", "Java");
  lacks("JavaScript", "Java");
});

t("R: R, Python / R/Python match; R$ 5.000 and R&D do not", () => {
  has("Linguagens: R, Python e SQL", "R");
  has("Python/R", "R");
  lacks("Salário: R$ 5.000 mais benefícios, SQL", "R");
  lacks("Sala R&D, SQL", "R");
  lacks("Vaga em R", "R"); // no data context
});

// --- I4 ambiguous aliases ----------------------------------------------------------------
t("ambiguous aliases are gated", () => {
  lacks("Experiência com CRM e HubSpot", "Salesforce");
  has("Salesforce CRM", "Salesforce");
  lacks("Tecido fabric importado", "Azure");
  has("Microsoft Fabric", "Azure");
  has("Fabric com Power BI", "Azure");
  lacks("Athena é uma deusa. Glue para colar. Plano s3", "AWS");
  has("AWS Glue e Athena", "AWS");
  lacks("Python e macros econômicas", "Excel");
  has("Macros em Excel", "Excel");
  lacks("Claude Silva, signo de gemini", "IA / LLMs");
  has("Claude Code e Google Gemini", "IA / LLMs");
  lacks("Trabalhamos com a API do cliente", "APIs");
  has("Integração via REST API", "APIs");
  lacks("go to market strategy", "Go");
  lacks("a gente sap", "SAP");
  has("Módulos SAP FI", "SAP");
  lacks("Acompanhar indicadores", "KPIs / Indicadores");
  has("Indicadores de desempenho", "KPIs / Indicadores");
});

// --- I1 negation + nice-to-have ----------------------------------------------------------
t("negation PT/EN", () => {
  lacks("Não exigimos SQL nem Python. Não é necessário Excel", "SQL", "Python", "Excel");
  lacks("No Python experience required", "Python");
  lacks("sem necessidade de inglês", "Inglês");
  lacks("English not required", "Inglês");
  lacks("Inglês não é obrigatório", "Inglês");
  has("Não exigimos SQL, mas Python é obrigatório", "Python");
  lacks("Não exigimos SQL, mas Python é obrigatório", "SQL");
  has("SQL required, English not required", "SQL");
  lacks("SQL required, English not required", "Inglês");
  const a = analyzeSkills("Não exigimos SQL nem Python.");
  assert.deepEqual([...a.negated].sort(), ["Python", "SQL"]);
});

t("nice-to-have counts half", () => {
  const a = analyzeSkills("Requisitos: SQL\nDiferencial: Python\nDesejável Tableau");
  assert.deepEqual(a.required, ["SQL"]);
  assert.deepEqual([...a.nice].sort(), ["Python", "Tableau"]);
  const sec = analyzeSkills("Requisitos:\n- Excel\nDiferenciais:\n- Power BI\n- Python\nBenefícios:\n- VR");
  assert.deepEqual(sec.required, ["Excel"]);
  assert.deepEqual([...sec.nice].sort(), ["Power BI", "Python"]);
  const j = analyzeJob(job({ title: "Analista de Dados", description: "Precisamos de SQL. Python é um diferencial. ".repeat(4) }), new Set(["SQL"]), new Set());
  assert.equal(j.skill_coverage, 0.67); // 1 / (1 + 0.5)
  assert.deepEqual(j.skills_nice, ["Python"]);
});

// --- I5 / I6 -----------------------------------------------------------------------------
t("user skills without dictionary entry match through their own aliases", () => {
  const f = write("a1.json", JSON.stringify({ skills: [{ key: "origami", aliases: ["dobradura papel"], knows: true }, { key: "power_bi", aliases: ["power bi"] }], languages: { english: "advanced", spanish: "basic" } }));
  const us = loadUserSkills(f);
  assert.ok(us.has("Power BI") && us.has("Origami") && us.has("Inglês") && !us.has("Espanhol"));
  const a = analyzeJob(job({ title: "Analista", description: "Vaga exige Power BI e dobradura papel avançada. ".repeat(4) }), us, new Set());
  assert.deepEqual([...a.skills_have].sort(), ["Origami", "Power BI"]);
});

t("dictionary now sees the user's data_analysis / people_analytics / iso / oracle_db", () => {
  const f = write("a2.json", JSON.stringify({ skills: [{ key: "data_analysis", aliases: ["análise de dados"] }, { key: "people_analytics", aliases: ["people analytics"] }, { key: "iso", aliases: ["iso"] }, { key: "oracle_db", aliases: ["oracle database"] }, { key: "market_research", aliases: ["pesquisa de mercado"] }] }));
  const us = loadUserSkills(f);
  for (const s of ["Análise de Dados", "People Analytics", "ISO", "Oracle DB", "Pesquisa de Mercado"]) assert.ok(us.has(s), s);
});

t("spoken languages are out of the coverage and give language_ok", () => {
  const us = new Set(["Inglês"]);
  const only = analyzeJob(job({ title: "Analista de Dados", description: "Inglês avançado é essencial para esta posição na empresa. ".repeat(3) }), us, new Set());
  assert.equal(only.skills_job.length, 0);
  assert.equal(only.skill_coverage, 0);
  assert.notEqual(only.match_level, "Alto");
  assert.deepEqual(only.languages_job, ["Inglês"]);
  const es = analyzeJob(job({ title: "Analista de Dados", description: "SQL e Python. Espanhol obrigatório para atendimento regional. ".repeat(3) }), new Set(["SQL", "Python"]), new Set());
  assert.equal(es.language_ok, false);
  assert.deepEqual(es.languages_missing, ["Espanhol"]);
  assert.deepEqual(es.skills_missing, []);
  const nice = analyzeJob(job({ title: "Analista de Dados", description: "SQL e Python. Espanhol desejável para atendimento regional. ".repeat(3) }), new Set(["SQL", "Python"]), new Set());
  assert.equal(nice.language_ok, true);
});

// --- I7 ----------------------------------------------------------------------------------
t("Pendente: null score; whitespace/short description is not text", () => {
  const a = analyzeJob(job({ title: "Analista de Dados Júnior" }), new Set(), new Set(["Júnior"]));
  assert.equal(a.match_level, "Pendente");
  assert.equal(a.match_score, null);
  assert.equal(analyzeJob(job({ title: "Analista de Dados", description: "   \n  " }), new Set(), new Set()).match_level, "Pendente");
  assert.equal(analyzeJob(job({ title: "Analista de Dados", description: "Vaga." }), new Set(), new Set()).match_level, "Pendente");
  const b = analyzeJob(job({ title: "Analista de Dados", requirements: '["SQL","Python","Excel"]' }), new Set(["SQL", "Python", "Excel"]), new Set());
  assert.equal(b.analyzed_from, "Descrição completa");
  assert.equal(typeof b.match_score, "number");
});

t("score is capped when seniority does not fit; estagio is Nao", () => {
  const sen = new Set(["Júnior" as const, "Pleno" as const]);
  const a = analyzeJob(job({ title: "Analista de Dados Sênior", description: "SQL Python Excel Power BI. ".repeat(8) }), new Set(["SQL", "Python", "Excel", "Power BI"]), sen);
  assert.equal(a.seniority_fit, "Não");
  assert.ok(a.match_score! <= 35);
  assert.equal(a.match_level, "Baixo");
  assert.equal(analyzeJob(job({ title: "Estágio em Dados", description: "SQL Python Excel. ".repeat(8) }), new Set(["SQL", "Python", "Excel"]), sen).seniority_fit, "Não");
});

// --- I8 / I9 -----------------------------------------------------------------------------
t("seniority", () => {
  assert.equal(inferSeniority("Product Manager", null), "Não informado");
  assert.equal(inferSeniority("Gerente de Contas", null), "Não informado");
  assert.equal(inferSeniority("Gerente de Dados", null), "Liderança");
  assert.equal(inferSeniority("Analista de BI (Junior/Pleno)", null), "Júnior");
  assert.equal(inferSeniority("Analista Pleno/Sênior", null), "Pleno");
  assert.equal(inferSeniority("Analista de Dados e I.A.", null), "Não informado");
  assert.equal(inferSeniority("Analista de Dados I", null), "Júnior");
  assert.equal(inferSeniority("Analista de Dados III", null), "Sênior");
  assert.equal(inferSeniority("Lead Generation Analyst", null), "Não informado");
  assert.equal(inferSeniority("Tech Lead", null), "Liderança");
  assert.equal(inferSeniority("Analista de Dados", "Buscamos 6 anos de experiência com BI"), "Sênior");
  assert.equal(inferSeniority("Analista de Dados", "2 years of experience"), "Júnior");
  assert.equal(inferSeniority("Analista de Dados Júnior", "6 anos de experiência"), "Júnior");
});

t("areas", () => {
  assert.equal(inferArea("Analista de RH"), "RH / People");
  assert.equal(inferArea("Analista de Pricing"), "Pricing");
  assert.equal(inferArea("Consultor Jurídico"), "Jurídico");
  assert.equal(inferArea("Analista de Vendas"), "Vendas / Comercial");
  assert.equal(inferArea("Analista de Suporte"), "TI / Suporte");
  assert.equal(inferArea("Analista de Dados e I.A."), "Ciência de Dados / IA");
  assert.equal(inferArea("Analista de Dados"), "Análise de Dados / BI");
});

// --- C2 answers loading ---------------------------------------------------------------------
t("loadAnswers: missing -> null; invalid -> clear error with line; mtime cache", () => {
  assert.equal(loadAnswers(path.join(tmp, "nope.json")), null);
  const bad = write("bad.json", '{\n  "target": {\n    "seniority": ["entry"],\n  }\n}');
  assert.throws(() => loadAnswers(bad), /answers\.json is invalid JSON at line \d+/);
  assert.throws(() => loadTarget(bad), /invalid JSON/);
  assert.throws(() => loadUserSkills(bad), /invalid JSON/);
  assert.throws(() => loadTargetSeniority(bad), /invalid JSON/);
  assert.throws(() => loadAnswers(write("arr.json", "[1]")), /JSON object/);
  const f = write("ok.json", '{"target":{"seniority":["entry"]}}');
  const first = loadAnswers(f);
  assert.equal(loadAnswers(f), first, "same object while the file is unchanged");
  fs.writeFileSync(f, '{"target":{"seniority":["senior","director"]}}');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(loadTarget(f)?.seniority, ["senior", "director"]);
  assert.deepEqual([...loadTargetSeniority(f)].sort(), ["Liderança", "Sênior", "Especialista"].sort());
});

// --- bank hybrid_area ------------------------------------------------------------------------
t("hybrid_area is whole-word: SP does not match Espirito Santo", () => {
  const tg: Target = { include_titles: [], exclude_titles: [], excluded_companies: [], seniority: [], modalities: ["hybrid"], hybrid_area: ["SP"] };
  assert.equal(fitsPreferences("Analista", "Vitória, Espírito Santo (Híbrido)", tg), false);
  assert.equal(fitsPreferences("Analista", "Campinas (Híbrido)", tg), false);
  assert.equal(fitsPreferences("Analista", "São Paulo, SP (Híbrido)", tg), true);
  assert.equal(fitsPreferences("Analista", "Brasil (Remoto)", tg), true);
});

t("I7 fitsPreferences: decomposed (NFD) 'Híbrido' / 'Presencial' are recognised", () => {
  const tg: Target = { include_titles: [], exclude_titles: [], excluded_companies: [], seniority: [], modalities: ["remote", "hybrid"], hybrid_area: ["SP"] };
  const nfd = "Vitória, Espírito Santo (Híbrido)".normalize("NFD");
  assert.notEqual(nfd, "Vitória, Espírito Santo (Híbrido)");
  assert.equal(fitsPreferences("Analista", nfd, tg), false); // hybrid outside the area, even in NFD
  assert.equal(fitsPreferences("Analista", "São Paulo, SP (Híbrido)".normalize("NFD"), tg), true);
  assert.equal(fitsPreferences("Analista", "São Paulo (PRESENCIAL)", tg), false);
});

t("I2 apply_prepare offers only analysed fits: Alto/Médio, never Pendente (title only) or Baixo", () => {
  assert.deepEqual((["Alto", "Médio", "Baixo", "Pendente"] as const).filter(offerableForApply), ["Alto", "Médio"]);
  // a title-only job is Pendente, so it is not offered
  const pend = analyzeJob(job({ title: "Analista de Dados" }), new Set(["SQL"]), new Set());
  assert.equal(pend.match_level, "Pendente");
  assert.equal(offerableForApply(pend.match_level), false);
});

t("I7 fitsJobPage: re-check from the job page's top card (location + modality pill), cache fills gaps", () => {
  const tg: Target = { include_titles: [], exclude_titles: [], excluded_companies: [], seniority: [], modalities: ["remote", "hybrid"], hybrid_area: ["SP"] };
  const cached = { title: "Analista de Dados", location: "São Paulo, SP (Remoto)" };
  assert.equal(fitsJobPage({ location: "São Paulo, SP", modality: "Remoto" }, cached, tg), true);
  assert.equal(fitsJobPage({ location: "São Paulo, SP", modality: "Presencial" }, cached, tg), false); // changed since the search
  assert.equal(fitsJobPage({ location: "Curitiba, PR", modality: "Híbrido" }, cached, tg), false);
  assert.equal(fitsJobPage({}, cached, tg), true); // unreadable top card: the cached "(Remoto)" is used
  assert.equal(fitsJobPage({ modality: "Presencial" }, { title: "Analista", location: "São Paulo, SP" }, tg), false);
  assert.equal(fitsJobPage({ location: "São Paulo, SP", modality: "Presencial" }, cached, null), true); // no target: no filter
});

// --- M1 ----------------------------------------------------------------------------------------
t("huge text is bounded and fast", () => {
  const start = Date.now();
  skillsInText("sql ".repeat(1_000_000));
  assert.ok(Date.now() - start < 5000);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASS");
