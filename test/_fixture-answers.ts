// Synthetic answer bank for the form-fill tests: same shape as docs/answers.template.json, fake values only.
import fs from "node:fs";
import path from "node:path";

/** Skills and job targets the form-fill tests rely on: the public template ships none, so they live here. */
const FAKE_SKILLS = [
  { key: "excel", aliases: ["excel","microsoft excel"], years: null, knows: null },
  { key: "excel_dashboards", aliases: ["excel dashboards","dashboards no excel"], years: null, knows: null },
  { key: "sql", aliases: ["sql","postgresql"], years: null, knows: null },
  { key: "power_bi", aliases: ["power bi","microsoft power bi"], years: null, knows: null },
  { key: "python", aliases: ["python"], years: null, knows: null },
  { key: "data_analysis", aliases: ["análise de dados","analise de dados","data analysis","data analytics"], years: null, knows: null },
  { key: "people_analytics", aliases: ["análise de pessoas","people analytics"], years: null, knows: null },
  { key: "market_research", aliases: ["market research","pesquisa de mercado"], years: null, knows: null },
  { key: "ai", aliases: ["artificial intelligence","ai","inteligência artificial","ia"], years: null, knows: null },
  { key: "learning_analytics", aliases: ["learning analytics"], years: null, knows: null },
  { key: "hr_kpis", aliases: ["indicadores de rh","hr metrics","hr kpis"], years: null, knows: null },
  { key: "databricks", aliases: ["databricks","dtb"], years: null, knows: null },
  { key: "oci", aliases: ["oracle cloud","oci","oracle cloud infrastructure"], years: null, knows: null },
  { key: "oracle_db", aliases: ["banco de dados oracle","oracle database"], years: null, knows: null },
  { key: "azure", aliases: ["azure","microsoft azure"], years: null, knows: null },
  { key: "pyspark", aliases: ["pyspark","spark","apache spark"], years: null, knows: null },
  { key: "claude", aliases: ["claude","anthropic claude"], years: null, knows: null },
  { key: "gemini", aliases: ["google gemini","gemini"], years: null, knows: null },
  { key: "power_automate", aliases: ["power automate","microsoft power automate"], years: null, knows: null },
  { key: "git", aliases: ["git","github"], years: null, knows: null },
  { key: "iso", aliases: ["normas iso","iso"], years: null, knows: null },
  { key: "javascript", aliases: ["javascript"], years: null, knows: null },
  { key: "react", aliases: ["react","react.js","react js"], years: null, knows: null },
];
const FAKE_TARGET = { include_titles: ["dados","data","bi","business intelligence","analytics","analista de dados","data analyst","power bi","analytics engineer"], exclude_titles: [], seniority: ["entry", "associate"], modalities: ["remote", "hybrid"], hybrid_area: ["<cidade>"], excluded_companies: [] };

export function fakeAnswers() {
  const tpl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "answers.template.json"), "utf8"));
  const a = structuredClone(tpl);
  a.skills = structuredClone(FAKE_SKILLS);
  a.target = { ...a.target, ...structuredClone(FAKE_TARGET) };
  a.profile = {
    ...a.profile,
    first_name: "Fulano", last_name: "Detal", email: "fulano@example.com",
    phone: { country_option: "Brasil (+55)", national: "11900000000" },
    location_city: { pt: "Cidade Teste, São Paulo, Brasil", en: "Cidade Teste, Sao Paulo, Brazil", typeahead_query: "Cidade Teste" },
    linkedin_url: "https://www.linkedin.com/in/fake", portfolio_url: "https://example.com", github_url: "https://github.com/fake",
    current_employer: "Acme Fake Ltda", current_role: "Analista", currently_employed: true,
    total_years_experience: 3, years_in_data: 1, cpf: "000.000.000-00",
  };
  a.mobility = {
    ...a.mobility, accepts_remote: true, accepts_remote_abroad: true, accepts_hybrid: true, accepts_onsite: false,
    willing_to_relocate: true, work_authorized_countries: ["BR", "PT", "EU"], eu_citizenship: true,
    needs_visa_sponsorship: { BR: false, EU: false, US: true, other: true },
  };
  for (const s of a.skills) { s.years = 2; s.knows = true; }
  a.education = { ...a.education, higher_ed_status: "technologist_complete", levels_completed: ["technologist"], certifications: [{ name: "Fake Cloud Practitioner", issuer: "X" }, { name: "Scrum Fundamentals", issuer: "Y" }] };
  a.languages = { english: "advanced", english_linkedin_scale: "Professional", spanish: "basic", spanish_linkedin_scale: "Conversational", portuguese: "native" };
  a.compensation.desired_clt_monthly_brl = { min: 5000, max: 7000, single_value: 6000 };
  a.compensation.current_salary = { gross_monthly_brl: 4000, text_pt: "R$ 4.000 brutos", text_en: "BRL 4,000 gross" };
  a.compensation.current_benefits.text_pt = "VR e VT";
  a.compensation.current_benefits.text_en = "Meal and transport vouchers";
  a.availability = { contract_types: ["clt"], notice_period_days: 30 };
  a.consents = { privacy_lgpd: true, ai_screening: true, truthfulness: true };
  a.documents.resume_by_language = { pt: "cv-fake-pt.pdf", en: "cv-fake-en.pdf", bilingual: "en" };
  a.documents.follow_company = false;
  return a;
}
