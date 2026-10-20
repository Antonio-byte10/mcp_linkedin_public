import path from "node:path";
import ExcelJS from "exceljs";
import { analyzeJob, loadTargetSeniority, loadUserSkills, safeReqs, type JobAnalysis } from "../analysis/match.js";
import { parseSalaryRange, parseYearsRequired } from "../analysis/jobFields.js";
import { config } from "../config.js";
import type { JobRow } from "../store/db.js";
import { clipCell, linkCell, uniqueExportPath } from "./xlsx.js";

const LEVEL_FILL: Record<string, string> = { Alto: "FFC6EFCE", Médio: "FFFFEB9C", Baixo: "FFFFC7CE", Pendente: "FFD9D9D9" };

/** English/lowercase labels from the location suffix are normalised to the Portuguese ones so Excel filters agree. */
const MODALITY_PT: Record<string, string> = { remoto: "Remoto", remote: "Remoto", hibrido: "Híbrido", hybrid: "Híbrido", presencial: "Presencial", "on-site": "Presencial", onsite: "Presencial" };
const normModality = (m: string) => MODALITY_PT[m.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim()] ?? m;
export const modalityOf = (j: Pick<JobRow, "modality" | "location">) => normModality(j.modality || j.location?.match(/\((Remoto|Híbrido|Presencial|Remote|Hybrid|On-site)\)/i)?.[1] || "");
const applyTypeOf = (j: JobRow) => (j.easy_apply === 1 ? "Candidatura simplificada" : j.easy_apply === 0 ? "Site da empresa" : "Desconhecido");

function styleHeader(ws: ExcelJS.Worksheet) {
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: "FFFFFFFF" } };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  h.alignment = { vertical: "middle", wrapText: true };
  h.height = 30;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}


/** Description plus the advertiser's requirements: either may hold "3+ anos" or a salary. */
const jobText = (j: JobRow) => `${j.description ?? ""}\n${safeReqs(j).join("\n")}`;

export type ReportRow = JobRow & { a: JobAnalysis };

/** Analysis-ready workbook: Vagas (one row per job), Vaga x Skill (long format), Skills (demand vs. yours), Resumo. */
export async function writeJobsReport(
  jobs: JobRow[],
  label = "vagas",
  opts: { dir?: string; answersFile?: string } = {},
): Promise<{ file: string; rows: number; by_level: Record<string, number>; note?: string }> {
  const userSkills = loadUserSkills(opts.answersFile);
  const target = loadTargetSeniority(opts.answersFile);
  const rows: ReportRow[] = jobs.map((j) => ({ ...j, a: analyzeJob(j, userSkills, target) }));
  const order = { Alto: 0, Médio: 1, Baixo: 2, Pendente: 3 } as const;
  rows.sort((x, y) => order[x.a.match_level] - order[y.a.match_level] || (y.a.match_score ?? -1) - (x.a.match_score ?? -1));

  const wb = new ExcelJS.Workbook();
  wb.creator = "mcp-linkedin";

  // 1) Vagas
  const ws = wb.addWorksheet("Vagas");
  ws.columns = [
    { header: "Match", key: "level", width: 9 },
    { header: "Score (0-100)", key: "score", width: 9 },
    { header: "Empresa", key: "company", width: 28 },
    { header: "Cargo", key: "title", width: 42 },
    { header: "Área", key: "area", width: 22 },
    { header: "Senioridade", key: "seniority", width: 14 },
    { header: "Senioridade compatível", key: "fit", width: 12 },
    { header: "Cobertura de skills (%)", key: "coverage", width: 11 },
    { header: "Nº skills pedidas", key: "n_job", width: 9 },
    { header: "Skills que você tem", key: "have", width: 40 },
    { header: "Skills que faltam", key: "missing", width: 40 },
    { header: "Todas as skills da vaga", key: "skills", width: 50 },
    { header: "Skills só desejáveis", key: "nice", width: 30 },
    { header: "Idiomas exigidos", key: "langs", width: 16 },
    { header: "Idiomas OK", key: "lang_ok", width: 10 },
    { header: "Modalidade", key: "modality", width: 12 },
    { header: "Local", key: "location", width: 32 },
    { header: "Tipo de contrato", key: "employment", width: 14 },
    { header: "Candidatos", key: "applicants", width: 16 },
    { header: "Publicada", key: "posted", width: 14 },
    { header: "Tipo de candidatura", key: "apply_type", width: 22 },
    { header: "Já me candidatei", key: "applied", width: 10 },
    { header: "Encerrada", key: "closed", width: 10 },
    { header: "Link da vaga (LinkedIn)", key: "url", width: 45 },
    { header: "Link de candidatura (site da empresa)", key: "apply_url", width: 45 },
    { header: "Página da empresa", key: "company_url", width: 40 },
    { header: "Anos de experiência exigidos", key: "years_req", width: 12 },
    { header: "Faixa salarial", key: "salary", width: 24 },
    { header: "Requisitos do anunciante", key: "requirements", width: 50 },
    { header: "Busca de origem", key: "search", width: 20 },
    { header: "Base da análise", key: "basis", width: 18 },
    { header: "Visto em", key: "first_seen", width: 18 },
    { header: "ID da vaga", key: "id", width: 13 },
  ];
  for (const r of rows) {
    const text = jobText(r);
    const row = ws.addRow({
      level: r.a.match_level,
      score: r.a.match_score,
      company: r.company ?? "",
      title: r.title ?? "",
      area: r.a.area,
      seniority: r.a.seniority,
      fit: r.a.seniority_fit,
      coverage: Math.round(r.a.skill_coverage * 100),
      n_job: r.a.skills_job.length,
      have: r.a.skills_have.join(", "),
      missing: r.a.skills_missing.join(", "),
      skills: r.a.skills_job.join(", "),
      nice: r.a.skills_nice.join(", "),
      langs: r.a.languages_job.join(", "),
      lang_ok: r.a.languages_job.length ? (r.a.language_ok ? "Sim" : "Não") : "",
      modality: modalityOf(r),
      location: (r.location ?? "").replace(/\s*\((Remoto|Híbrido|Presencial|Remote|Hybrid|On-site)\)/i, ""),
      employment: r.employment_type ?? "",
      applicants: r.applicants ?? "",
      posted: r.posted ?? "",
      apply_type: applyTypeOf(r),
      applied: r.applied ? "Sim" : "Não",
      closed: r.closed ? "Sim" : "Não",
      url: linkCell(r.url),
      apply_url: linkCell(r.apply_url),
      company_url: linkCell(r.company_url),
      years_req: parseYearsRequired(text) ?? "",
      salary: parseSalaryRange(text),
      requirements: clipCell(safeReqs(r).join(" | ")),
      search: r.search_keywords ?? "",
      basis: r.a.analyzed_from,
      first_seen: r.first_seen ?? "",
      id: r.id,
    });
    row.getCell("level").fill = { type: "pattern", pattern: "solid", fgColor: { argb: LEVEL_FILL[r.a.match_level] } };
    for (const k of ["url", "apply_url", "company_url"]) if (typeof row.getCell(k).value === "object") row.getCell(k).font = { color: { argb: "FF0563C1" }, underline: true };
  }
  styleHeader(ws);

  const file = uniqueExportPath(opts.dir ?? path.join(config.dataDir, "exports"), label);
  await wb.xlsx.writeFile(file);
  const by_level = rows.reduce<Record<string, number>>((m, r) => ((m[r.a.match_level] = (m[r.a.match_level] ?? 0) + 1), m), {});
  return { file, rows: rows.length, by_level, ...(rows.length ? {} : { note: "No jobs matched the filters: the workbook contains only the header." }) };
}

