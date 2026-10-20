/**
 * Skill dictionary used to read job text. Keys are canonical names (what goes in the
 * spreadsheet); aliases are matched as whole words on accent-free lowercase text
 * (see norm(): whitespace, hyphens and NBSP are all one space, "a.i." becomes "ai").
 */
export const SKILLS: Record<string, string[]> = {
  // languages / querying
  SQL: ["sql", "t-sql", "tsql", "pl/sql", "plsql", "postgresql", "postgres", "mysql", "sqlite", "sql server", "oracle sql"],
  Python: ["python", "pandas", "numpy"],
  R: ["linguagem r", "r language", "rstudio", "r studio"], // bare "R" is handled case-sensitively in analyzeSkills
  "Excel": ["excel", "planilhas", "vba", "macros excel", "macros vba", "macro excel"],
  "Excel Dashboards": ["dashboards no excel", "excel dashboards", "dashboard em excel"],
  "Google Sheets": ["google sheets", "google planilhas", "planilhas google"],
  JavaScript: ["javascript", "typescript", "node.js", "nodejs"],
  React: ["react", "react.js", "reactjs"],
  "C#": ["c#", "csharp", "c sharp"],
  "C++": ["c++", "cpp"],
  ".NET": [".net", "dotnet", "asp.net", "vb.net"],
  Go: ["golang"], // bare "go" is gated, see GATED
  Java: ["java"],
  Rust: ["rust"],
  NoSQL: ["nosql", "mongodb", "dynamodb", "cassandra", "redis"],
  // BI
  "Power BI": ["power bi", "powerbi", "pbi"],
  DAX: ["dax"],
  "Power Query": ["power query", "linguagem m"],
  Tableau: ["tableau"],
  "Looker / Looker Studio": ["looker", "looker studio", "data studio"],
  Qlik: ["qlik", "qlikview", "qlik sense"],
  Metabase: ["metabase"],
  SharePoint: ["sharepoint"],
  "Data Visualization": ["visualizacao de dados", "data visualization", "storytelling com dados", "data storytelling"],
  "KPIs / Indicadores": ["kpi", "kpis", "metricas de negocio", "okr", "okrs", "indicadores de desempenho", "indicadores de performance", "indicadores chave", "indicadores de negocio", "indicadores gerenciais", "indicadores de rh", "painel de indicadores"],
  // engineering / cloud
  ETL: ["etl", "elt", "pipelines de dados", "data pipeline", "data pipelines", "integracao de dados"],
  "SSIS / SSRS": ["ssis", "ssrs", "ssas"],
  Talend: ["talend"],
  Pentaho: ["pentaho"],
  Fivetran: ["fivetran"],
  Alteryx: ["alteryx"],
  "Apache Superset": ["superset", "apache superset"],
  "Data Governance": ["governanca de dados", "data governance"],
  "Data Quality": ["qualidade de dados", "data quality"],
  Terraform: ["terraform"],
  Jupyter: ["jupyter", "jupyter notebook", "jupyter notebooks"],
  "Data Modeling": ["modelagem de dados", "data modeling", "modelagem dimensional", "star schema", "data warehouse", "dwh"],
  "Data Lake": ["data lake", "datalake", "lakehouse", "data lakehouse"],
  Databricks: ["databricks"],
  "Spark / PySpark": ["spark", "pyspark", "apache spark"],
  Hadoop: ["hadoop"],
  Kafka: ["kafka"],
  Airflow: ["airflow"],
  dbt: ["dbt"],
  Snowflake: ["snowflake"],
  BigQuery: ["bigquery", "big query"],
  Azure: ["azure", "data factory", "synapse", "microsoft fabric"],
  AWS: ["aws", "amazon web services", "redshift"],
  GCP: ["gcp", "google cloud"],
  "Oracle Cloud (OCI)": ["oci", "oracle cloud"],
  "Oracle DB": ["oracle database", "banco de dados oracle", "oracle db"],
  Docker: ["docker"],
  Kubernetes: ["kubernetes", "k8s"],
  Git: ["git", "github", "gitlab"],
  "Power Automate": ["power automate", "power apps", "power platform"],
  APIs: ["apis", "rest api", "api rest", "restful", "web api"],
  // science / AI
  "Análise de Dados": ["analise de dados", "data analysis", "data analytics", "analise de dado"],
  "People Analytics": ["people analytics", "analise de pessoas", "analytics de pessoas", "hr analytics"],
  "Pesquisa de Mercado": ["pesquisa de mercado", "market research", "inteligencia de mercado"],
  "Learning Analytics": ["learning analytics"],
  SAS: ["sas viya", "sas enterprise guide", "sas analytics", "sas programming", "programacao sas"], // bare "SAS" is also a company suffix/Spanish word: not an alias
  Statistics: ["estatistica", "statistics", "estatistico"],
  "Machine Learning": ["machine learning", "aprendizado de maquina", "scikit-learn", "sklearn", "modelos preditivos"],
  "Deep Learning": ["deep learning", "redes neurais", "neural networks"],
  NLP: ["nlp", "processamento de linguagem natural", "natural language processing"],
  "IA / LLMs": ["inteligencia artificial", "artificial intelligence", "ai", "ia", "ia generativa", "genai", "generative ai", "llm", "llms", "chatgpt", "claude ai", "claude code", "anthropic", "google gemini", "gemini ai", "gemini pro", "openai"],
  Copilot: ["copilot", "github copilot", "microsoft copilot"],
  LangChain: ["langchain", "llamaindex"],
  // business systems
  SAP: ["sap erp", "sap hana", "sap s4hana", "sap s/4hana", "sap bw", "sap fi", "sap bi"], // bare uppercase "SAP" is case-sensitive, see CASE_SENSITIVE
  Salesforce: ["salesforce", "sales cloud"],
  "Google Analytics": ["google analytics", "ga4"],
  ISO: ["iso", "iso 9001", "normas iso"],
  // methods
  "Agile / Scrum": ["agile", "agil", "scrum", "kanban"],
  // languages (spoken): kept out of the skill coverage, see SPOKEN
  "Inglês": ["ingles", "english", "bilingue", "bilingual"],
  "Espanhol": ["espanhol", "spanish"],
};

/** Spoken languages are a separate yes/no (language_ok), not part of the skill coverage. */
export const SPOKEN = new Set(["Inglês", "Espanhol"]);

/**
 * Ambiguous short aliases: only count when `needs` also appears somewhere in the same text.
 * (crm, fabric, glue, athena, s3, dw, api, go, macros, indicadores ...)
 */
type Gated = { aliases: string[]; needs: RegExp };
export const GATED: Record<string, Gated[]> = {
  Azure: [{ aliases: ["fabric"], needs: /\b(microsoft|azure|power bi|onelake|synapse)\b/ }],
  AWS: [{ aliases: ["glue", "athena", "s3"], needs: /\b(aws|amazon|redshift|lambda|ec2|cloud)\b/ }],
  "Data Modeling": [{ aliases: ["dw"], needs: /\b(warehouse|etl|dwh|modelagem|star schema|sql)\b/ }],
  APIs: [{ aliases: ["api"], needs: /\b(integra\w*|rest|json|consum\w*|endpoint\w*|http\w*|backend|back end)\b/ }],
  Go: [{ aliases: ["go"], needs: /\b(golang|backend|back end|microservic\w*|kubernetes|docker|grpc|concurren\w*)\b/ }],
  Excel: [{ aliases: ["macros"], needs: /\b(excel|vba|planilhas?)\b/ }],
  "KPIs / Indicadores": [{ aliases: ["indicadores"], needs: /\b(dashboards?|paine[li]s?|relatorios?|power bi|kpis?|metas)\b/ }],
};

/** Case-sensitive rules on the raw text (cannot be told apart once lowercased). */
const WORD_L = "(?<![\\p{L}\\p{N}])";
const WORD_R = "(?![\\p{L}\\p{N}])";
const DATA_CTX = /\b(sql|python|estatistic\w*|statistic\w*|power bi|tableau|excel|dados|data|analytics|bi)\b/;
const CASE_SENSITIVE: Record<string, { re: RegExp; needsLower?: RegExp }> = {
  SAP: { re: new RegExp(`${WORD_L}SAP${WORD_R}`, "u") },
  // "R, Python" / "R/Python" / "(R)" but never "R$ 5.000" or "R&D"; only in a data context.
  R: { re: /(^|[\s,;/(])R([\s,;/).]|$)/, needsLower: DATA_CTX },
};

/**
 * Aliases for these skills may be followed by digits (python3, sql2019, java8).
 */
const DIGIT_SUFFIX = new Set(["SQL", "Python", "Java"]);

export const MAX_TEXT = 200_000;

/** Lowercase, accent-free; whitespace/hyphen/underscore/NBSP runs become one space (newlines kept for segmenting). "a.i." -> "ai". */
export const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+|[‐-―\-_]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/(?<![\p{L}\p{N}])(a\.\s?i|i\.\s?a)\.?(?![\p{L}\p{N}])/gu, (m) => m.replace(/[.\s]/g, ""))
    .trim();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const build = (aliases: string[], digits = false) =>
  new RegExp(`${WORD_L}(${[...new Set(aliases.map(norm))].sort((a, b) => b.length - a.length).map(escape).join("|")})${digits ? "\\d*" : ""}${WORD_R}`, "gu");

const MATCHERS: [string, RegExp][] = Object.entries(SKILLS).map(([k, al]) => [k, build(al, DIGIT_SUFFIX.has(k))]);
const GATED_MATCHERS: [string, RegExp, RegExp][] = Object.entries(GATED).flatMap(([k, gs]) => gs.map((g): [string, RegExp, RegExp] => [k, build(g.aliases), g.needs]));

// --- negation / optionality ---------------------------------------------------------------
/** Cue BEFORE the skill: "nao exigimos SQL nem Python", "sem necessidade de ingles". Window of 60 chars. */
const NEG_FWD = /\b(?:nao (?:exig\w*|precis\w*|requer\w*|necessit\w*|e (?:necessari\w*|obrigatori\w*|exigid\w*)|sao (?:necessari\w*|obrigatori\w*))|sem (?:necessidade|exigencia|obrigatoriedade)(?: de| em)?|dispensamos|dispensa\w*|no need (?:for|to have))/g;
/** "No Python experience required": skills inside the span are negated. */
const NEG_NO = /\bno\b[^\n]{0,50}?\b(?:required|needed|necessary|mandatory)\b/g;
/** Cue AFTER the skill: "english not required", "ingles nao e obrigatorio". Window of 40 chars. */
const NEG_BACK = /\b(?:(?:is |are )?not|nao(?: e| sao)?) (?:be )?(?:required|needed|necessary|mandatory|obrigatori\w*|necessari\w*|exigid\w*)/g;
const NICE = /\b(?:diferenci(?:al|ais)|desejaveis|desejavel|plus|nice to have|bonus|preferencial|preferivel|preferred|appreciated|valorizamos|valorizad\w+|pontos? extras?)\b/g;
const BREAK = /\b(?:mas|porem|contudo|but|however|although)\b|[,;()]/g;
const OBLIGATORY = /\b(?:obrigatori\w*|required|mandatory|exigid\w*)\b/;

/** Sentences/bullets: lines, ; and bullets, and ". " endings (not the "." in node.js or 5.000). */
const SEGMENT = /\n+|[;•·▪●◦]|[.!?](?=\s|$)/;

type Span = [number, number];

function negatedSpans(seg: string): Span[] {
  const out: Span[] = [];
  for (const m of seg.matchAll(NEG_FWD)) {
    const from = m.index! + m[0].length;
    let to = Math.min(seg.length, from + 60);
    const rest = seg.slice(from, to);
    const b = /\b(?:mas|porem|contudo|but|however|although)\b/.exec(rest);
    if (b) to = from + b.index;
    out.push([from, to]);
  }
  for (const m of seg.matchAll(NEG_NO)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of seg.matchAll(NEG_BACK)) {
    const end = m.index!;
    let from = Math.max(0, end - 40);
    const before = seg.slice(from, end);
    let cut = -1;
    for (const b of before.matchAll(BREAK)) cut = b.index! + b[0].length;
    if (cut >= 0) from += cut;
    out.push([from, end]);
  }
  return out;
}

type Cue = [number, number];

function isNice(seg: string, cues: Cue[], start: number, end: number): boolean {
  for (const [cs, ce] of cues) {
    if (ce <= start && start - ce <= 60) {
      const between = seg.slice(ce, start);
      if (!/\b(?:mas|but|however|porem)\b/.test(between) && !OBLIGATORY.test(between)) return true;
    }
    if (cs >= end && cs - end <= 30) return true;
  }
  return false;
}

export type SkillAnalysis = {
  /** Mentioned as a requirement (or without any qualifier). */
  required: string[];
  /** Only mentioned as nice-to-have ("diferencial", "desejável", "plus"). */
  nice: string[];
  /** Only mentioned as NOT needed ("não exigimos SQL"): dropped from the match. */
  negated: string[];
};

/**
 * Reads job text sentence by sentence. A skill is `negated` when a cue such as "não exigimos" /
 * "sem necessidade de" / "no ... required" / "... not required" covers it, `nice` when a cue such as
 * "diferencial" / "desejável" / "plus" does (also for a whole "Diferenciais:" section). A skill that
 * appears once as a plain requirement is required regardless of other mentions.
 * `extra` are the user's own skills that have no dictionary entry (alias lists, matched like the rest).
 */
export function analyzeSkills(text: string, extra: Record<string, string[]> = {}): SkillAnalysis {
  const raw = (text ?? "").slice(0, MAX_TEXT);
  const t = norm(raw);
  const hits = new Map<string, { req: boolean; nice: boolean; neg: boolean }>();
  const note = (k: string, kind: "req" | "nice" | "neg") => {
    const h = hits.get(k) ?? { req: false, nice: false, neg: false };
    h[kind] = true;
    hits.set(k, h);
  };

  const matchers: [string, RegExp][] = [
    ...MATCHERS,
    ...GATED_MATCHERS.filter(([, , needs]) => needs.test(t)).map(([k, re]): [string, RegExp] => [k, re]),
    ...Object.entries(extra).map(([k, al]): [string, RegExp] => [k, build(al)]),
  ];

  // Sentences/bullets with their offsets. Matching runs on the text with newlines as spaces (same
  // offsets), so "Power\nBI" still matches; the segment of the match start decides negation/nice.
  type Seg = { text: string; start: number; nice: boolean; neg?: Span[]; cues?: Cue[] };
  const segs: Seg[] = [];
  let pos = 0;
  let niceSection = false;
  const push = (end: number) => {
    const text = t.slice(pos, end);
    const trimmed = text.trim();
    // "Diferenciais:" on its own line makes the following bullets nice until another heading.
    const heading = trimmed.length > 0 && trimmed.length <= 40 && trimmed.endsWith(":");
    segs.push({ text, start: pos, nice: niceSection });
    if (heading) niceSection = /\b(?:diferenci(?:al|ais)|desejaveis|desejavel|plus|nice to have|bonus|preferencial|preferred)\b/.test(trimmed);
  };
  for (const m of t.matchAll(new RegExp(SEGMENT.source, "g"))) {
    push(m.index!);
    pos = m.index! + m[0].length;
  }
  push(t.length);
  const flat = t.replace(/\n/g, " ");

  for (const [k, re] of matchers) {
    re.lastIndex = 0;
    let si = 0;
    for (const m of flat.matchAll(re)) {
      while (si < segs.length - 1 && segs[si + 1].start <= m.index!) si++;
      const seg = segs[si];
      const a = m.index! - seg.start;
      const b = Math.min(a + m[0].length, seg.text.length);
      seg.neg ??= negatedSpans(seg.text);
      seg.cues ??= [...seg.text.matchAll(NICE)].map((c): Cue => [c.index!, c.index! + c[0].length]);
      if (seg.neg.some(([x, y]) => a >= x && b <= y)) note(k, "neg");
      else if (seg.nice || isNice(seg.text, seg.cues, a, b)) note(k, "nice");
      else {
        note(k, "req");
        break; // a plain requirement settles the skill
      }
    }
  }

  // Case-sensitive: "SAP" (not the Portuguese "sap"), bare "R" in a data context ("R$ 5.000" never matches).
  const rawSp = raw.replace(/ /g, " ");
  for (const [k, c] of Object.entries(CASE_SENSITIVE)) {
    if (c.re.test(rawSp) && (!c.needsLower || c.needsLower.test(t))) note(k, "req");
  }

  const order = [...Object.keys(SKILLS), ...Object.keys(extra)];
  const out: SkillAnalysis = { required: [], nice: [], negated: [] };
  for (const k of order) {
    const h = hits.get(k);
    if (!h) continue;
    if (h.req) out.required.push(k);
    else if (h.nice) out.nice.push(k);
    else out.negated.push(k);
  }
  return out;
}

/** Canonical skills mentioned in a job's text (title + description + requirements), required and nice-to-have, not negated. */
export function skillsInText(text: string, extra: Record<string, string[]> = {}): string[] {
  const a = analyzeSkills(text, extra);
  const keep = new Set([...a.required, ...a.nice]);
  return [...Object.keys(SKILLS), ...Object.keys(extra)].filter((k) => keep.has(k));
}

const SKILL_NAMES = new Set(Object.entries(SKILLS).flatMap(([k, a]) => [k, ...a]).map((s) => norm(s).trim()));
/** A skill / tool name or alias ("Python", "Power BI"), case- and accent-insensitive. */
export const isSkillName = (s: string) => SKILL_NAMES.has(norm(s).trim());

/**
 * Looks like a company name: starts upper-case, with a digit or camelCase ("iFood", "eBay"), and is not a skill
 * ("…na Python"). A plain lower-case start ("área de dados") is a subject, not a company.
 */
export const looksLikeCompany = (s: string) => /^([\p{Lu}\d]|\p{Ll}+\p{Lu})/u.test(s) && !isSkillName(s);
