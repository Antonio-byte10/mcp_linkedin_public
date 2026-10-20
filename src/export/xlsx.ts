import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "../config.js";

/** Excel's hard limit is 32,767 chars per cell; longer text makes it report a corrupt file. */
export const CELL_MAX = 32000;

export const clipCell = <T>(v: T): T => (typeof v === "string" && v.length > CELL_MAX ? ((v.slice(0, CELL_MAX - 1) + "…") as unknown as T) : v);

/**
 * Local (Sao Paulo) timestamp, never dated "tomorrow" after 21:00. Includes milliseconds and a
 * random suffix, so two exports in the same second (or one still open in Excel) never collide.
 */
export function exportStamp(d = new Date()): string {
  const base = d.toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(/[-: ]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
  return `${base}-${String(d.getMilliseconds()).padStart(3, "0")}-${crypto.randomBytes(2).toString("hex")}`;
}

/** `<dir>/<name>-<stamp>.xlsx`, creating dir; never returns a path that already exists. */
export function uniqueExportPath(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; ; i++) {
    const f = path.join(dir, `${name}-${exportStamp()}${i ? `-${i}` : ""}.xlsx`);
    if (!fs.existsSync(f)) return f;
  }
}

/** Only http/https may become a clickable link (a third-party apply_url could be javascript:, file:, ms-*: ...). */
export function safeHyperlink(u: string | null | undefined): string | null {
  const s = (u ?? "").trim();
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Cell for a URL column: clickable when the scheme is allowed, plain text otherwise. */
export const linkCell = (u: string | null | undefined) => {
  const h = safeHyperlink(u);
  return h ? { text: clipCell(String(u).trim()), hyperlink: h } : clipCell(u ?? "");
};

/** Escapes % _ and \ so a user keyword is matched literally with `LIKE ? ESCAPE '\'`. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");
/** `%keyword%` for `LIKE ? ESCAPE '\'`. For an empty keyword callers should skip the WHERE clause entirely. */
export const likeContains = (keyword: string | undefined) => `%${escapeLike((keyword ?? "").trim())}%`;

/** Header for the known sheets, so an empty export still has its columns. */
const DEFAULT_COLUMNS: Record<string, string[]> = {
  people: ["name", "headline", "role", "company", "location", "degree", "url"],
  leads: ["name", "industry", "size", "website", "location", "url"],
};

const isLinkColumn = (k: string) => /^(url|website|apply_url|company_url|profile_url|linkedin_url)$/i.test(k) || /_url$/i.test(k);

export type WriteXlsxOpts = {
  /** Output directory (default <data folder>/exports). */
  dir?: string;
  /** Header for an empty export (default: known columns for `name`, else none). */
  columns?: string[];
};

export async function writeXlsx(name: string, sheet: string, rows: Record<string, unknown>[], opts: WriteXlsxOpts = {}): Promise<string> {
  const file = uniqueExportPath(opts.dir ?? path.join(config.dataDir, "exports"), name);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  // Union of keys over all rows (the first row may lack optional fields); fixed header when empty.
  const cols = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : (opts.columns ?? DEFAULT_COLUMNS[name] ?? []);
  ws.columns = cols.map((k) => ({ header: k, key: k, width: isLinkColumn(k) ? 45 : Math.min(60, Math.max(14, k.length + 4)) }));
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const k of cols) {
      const v = r[k];
      out[k] = isLinkColumn(k) && (typeof v === "string" || v == null) ? linkCell(v as string | null) : clipCell(v);
    }
    const row = ws.addRow(out);
    for (const k of cols) if (isLinkColumn(k) && typeof out[k] === "object") row.getCell(k).font = { color: { argb: "FF0563C1" }, underline: true };
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  await wb.xlsx.writeFile(file);
  return file;
}
