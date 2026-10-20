// Run: npx tsx test/export.test.ts   (writes xlsx into a temp dir only; never data/exports or data/linkedin.db)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { writeJobsReport, modalityOf } from "../src/export/jobsReport.js";
import { CELL_MAX, escapeLike, likeContains, safeHyperlink, uniqueExportPath, writeXlsx } from "../src/export/xlsx.js";
import type { JobRow } from "../src/store/db.js";

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).message}`);
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-export-"));
const load = async (file: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
};
const job = (o: Partial<JobRow>): JobRow => ({ id: "1", title: "Analista de Dados", company: "Acme", location: null, url: "https://www.linkedin.com/jobs/view/1/", easy_apply: null, posted: null, description: null, applied: 0, closed: 0, apply_url: null, tracker_seen: 0, enriched_at: null, modality: null, employment_type: null, applicants: null, requirements: null, company_url: null, search_keywords: null, first_seen: null, posted_at: null, enrich_attempts: 0, enrich_failed_at: null, ...o });
const answers = path.join(dir, "answers.json");
fs.writeFileSync(answers, JSON.stringify({ skills: [{ key: "sql", aliases: ["sql"] }], languages: { english: "advanced" }, target: { seniority: ["entry"] } }));

await t("two exports in the same instant never collide", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const f = uniqueExportPath(dir, "people");
    assert.ok(!seen.has(f));
    seen.add(f);
    fs.writeFileSync(f, "x");
  }
  assert.equal(seen.size, 200);
  assert.match(path.basename([...seen][0]), /^people-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}(-\d+)?\.xlsx$/);
});

await t("empty export keeps the header (people, leads, custom)", async () => {
  const f = await writeXlsx("people", "People", [], { dir });
  const ws = (await load(f)).getWorksheet("People")!;
  assert.deepEqual((ws.getRow(1).values as string[]).slice(1), ["name", "headline", "role", "company", "location", "degree", "url"]);
  assert.equal(ws.rowCount, 1);
  const g = await writeXlsx("leads", "Leads", [], { dir });
  assert.deepEqual(((await load(g)).getWorksheet("Leads")!.getRow(1).values as string[]).slice(1), ["name", "industry", "size", "website", "location", "url"]);
  const h = await writeXlsx("custom", "S", [], { dir, columns: ["a", "b"] });
  assert.deepEqual(((await load(h)).getWorksheet("S")!.getRow(1).values as string[]).slice(1), ["a", "b"]);
});

await t("people urls are clickable, only http/https; website gets a scheme", async () => {
  const f = await writeXlsx("people", "People", [
    { name: "A", url: "https://www.linkedin.com/in/a" },
    { name: "B", url: "javascript:alert(1)" },
    { name: "C", url: "file:///etc/passwd" },
    { name: "D", url: null },
  ], { dir });
  const ws = (await load(f)).getWorksheet("People")!;
  const urlCol = 2;
  const cell = (r: number) => ws.getRow(r).getCell(urlCol).value as { text: string; hyperlink: string } | string | null;
  assert.deepEqual(cell(2), { text: "https://www.linkedin.com/in/a", hyperlink: "https://www.linkedin.com/in/a", });
  assert.equal(typeof cell(3), "string");
  assert.equal(cell(3), "javascript:alert(1)");
  assert.equal(typeof cell(4), "string");
  const g = await writeXlsx("leads", "Leads", [{ name: "L", website: "acme.com.br" }, { name: "M", website: "ms-msdt:/x" }], { dir });
  const lw = (await load(g)).getWorksheet("Leads")!;
  const w = (r: number) => lw.getRow(r).getCell(2).value as { hyperlink: string } | string;
  assert.equal((w(2) as { hyperlink: string }).hyperlink, "https://acme.com.br/");
  assert.equal(typeof w(3), "string");
});

await t("safeHyperlink allow-list", () => {
  assert.equal(safeHyperlink("http://a.com/x"), "http://a.com/x");
  for (const bad of ["javascript:alert(1)", "file:///c:/x", "ms-word:ofe|u|http://a.com", "data:text/html,x", "", null, "localhost:3000", "vbscript:x"]) assert.equal(safeHyperlink(bad as string), null, String(bad));
});

await t("cells over 32k are clipped (file reloads fine)", async () => {
  const f = await writeXlsx("people", "People", [{ name: "A", headline: "x".repeat(40000) }], { dir });
  const v = (await load(f)).getWorksheet("People")!.getRow(2).getCell(2).value as string;
  assert.ok(v.length <= CELL_MAX);
});

await t("rows with different keys: header is the union", async () => {
  const f = await writeXlsx("misc", "S", [{ a: 1 }, { a: 2, b: 3 }], { dir });
  const ws = (await load(f)).getWorksheet("S")!;
  assert.deepEqual((ws.getRow(1).values as string[]).slice(1), ["a", "b"]);
  assert.equal(ws.getRow(3).getCell(2).value, 3);
});

await t("LIKE escaping", () => {
  assert.equal(escapeLike("100%_a\\b"), "100\\%\\_a\\\\b");
  assert.equal(likeContains("a_b"), "%a\\_b%");
  assert.equal(likeContains(undefined), "%%");
});

await t("jobs report: bad requirements JSON, hostile apply_url, Pendente, sorting, collisions", async () => {
  const jobs = [
    job({ id: "1", title: "Analista de Dados Júnior", description: "SQL e Python no dia a dia. ".repeat(6), requirements: "not json", apply_url: "javascript:alert(1)", location: "São Paulo (Hybrid)" }),
    job({ id: "2", title: "Analista de Dados" }), // Pendente
    job({ id: "3", title: "Analista de Dados Júnior", requirements: JSON.stringify(["SQL", "y".repeat(40000)]), apply_url: "https://empresa.com/vaga", company_url: "https://www.linkedin.com/company/acme/" }),
  ];
  const r1 = await writeJobsReport(jobs, "vagas", { dir, answersFile: answers });
  const r2 = await writeJobsReport(jobs, "vagas", { dir, answersFile: answers });
  assert.notEqual(r1.file, r2.file);
  assert.equal(r1.rows, 3);
  assert.equal(r1.by_level.Pendente, 1);
  const ws = (await load(r1.file)).getWorksheet("Vagas")!;
  const head = (ws.getRow(1).values as string[]).slice(1);
  const col = (k: string) => head.indexOf(k) + 1;
  assert.ok(col("Match") > 0 && col("Idiomas exigidos") > 0);
  const rows = Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2));
  const byId = (id: string) => rows.find((r) => String(r.getCell(col("ID da vaga")).value) === id)!;
  assert.equal(byId("2").getCell(col("Match")).value, "Pendente");
  assert.equal(byId("2").getCell(col("Score (0-100)")).value, null, "Pendente has no score");
  assert.equal(rows[rows.length - 1].getCell(col("ID da vaga")).value, "2", "Pendente sorts last");
  const bad = byId("1").getCell(col("Link de candidatura (site da empresa)")).value;
  assert.equal(typeof bad, "string", "javascript: is plain text");
  const good = byId("3").getCell(col("Link de candidatura (site da empresa)")).value as { hyperlink: string };
  assert.equal(good.hyperlink, "https://empresa.com/vaga");
  assert.ok((byId("3").getCell(col("Requisitos do anunciante")).value as string).length <= CELL_MAX);
  assert.equal(byId("1").getCell(col("Modalidade")).value, "Híbrido", "English suffix normalised");
  assert.equal(byId("1").getCell(col("Base da análise")).value, "Descrição completa");
});

await t("jobs report with no jobs: header only plus a note", async () => {
  const r = await writeJobsReport([], "vazio", { dir, answersFile: answers });
  assert.equal(r.rows, 0);
  assert.ok(r.note);
  const ws = (await load(r.file)).getWorksheet("Vagas")!;
  assert.equal(ws.getRow(1).getCell(1).value, "Match");
});

await t("modalityOf", () => {
  assert.equal(modalityOf({ modality: null, location: "X (Remote)" }), "Remoto");
  assert.equal(modalityOf({ modality: "Remoto", location: null }), "Remoto");
  assert.equal(modalityOf({ modality: null, location: "X (On-site)" }), "Presencial");
});

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASS");
