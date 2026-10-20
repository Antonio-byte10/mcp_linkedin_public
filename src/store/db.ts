import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { isMutualText } from "../linkedin/peoplePure.js";
import { normaliseProfileId } from "../linkedin/writeRules.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath, { timeout: 5000 });
db.exec("PRAGMA journal_mode=WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT, url TEXT,
  easy_apply INTEGER, posted TEXT, description TEXT,
  applied INTEGER DEFAULT 0, closed INTEGER DEFAULT 0, apply_url TEXT,
  tracker_seen INTEGER DEFAULT 0, enriched_at TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, target TEXT,
  status TEXT, detail TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS people (
  url TEXT PRIMARY KEY, name TEXT, headline TEXT, company TEXT, role TEXT, location TEXT,
  degree TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS companies (
  url TEXT PRIMARY KEY, name TEXT, industry TEXT, size TEXT, website TEXT,
  location TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, items TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS saved_searches (
  name TEXT PRIMARY KEY, params TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_run_at TEXT
);
`);
/** Adds columns introduced after a db file was created (CREATE TABLE IF NOT EXISTS won't). */
function ensureColumns(table: string, cols: Record<string, string>) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
ensureColumns("jobs", {
  closed: "INTEGER DEFAULT 0", apply_url: "TEXT", tracker_seen: "INTEGER DEFAULT 0", enriched_at: "TEXT",
  // job-page details (jobs_get / jobs_enrich), used by the analysis export
  modality: "TEXT", employment_type: "TEXT", applicants: "TEXT", requirements: "TEXT", company_url: "TEXT",
  search_keywords: "TEXT",
  // posted_at: absolute publish date derived once from the relative "há 2 dias"; enrich_*: failed job-page reads (retry cap)
  posted_at: "TEXT", enrich_attempts: "INTEGER DEFAULT 0", enrich_failed_at: "TEXT",
});
ensureColumns("people", { role: "TEXT" });
// last_seen: bumped on every re-sighting; data_purge ages rows by it (first_seen alone would purge people we keep seeing). NULL = unknown age.
ensureColumns("people", { last_seen: "TEXT" });
ensureColumns("companies", { last_seen: "TEXT" });
ensureColumns("jobs", { last_seen: "TEXT" });
// One-off: rows cached before last_seen existed would age by first_seen, so the first purge after the upgrade could
// delete people seen last week. Stamp them once (kv flag, so it also covers dbs that already had the column).
// Idempotent + OR IGNORE: Desktop and Code may start their servers on the same db at once.
if (!db.prepare(`SELECT 1 FROM kv WHERE k='migrate:last_seen_backfill'`).get()) {
  db.exec(`BEGIN IMMEDIATE;
    UPDATE people SET last_seen=CURRENT_TIMESTAMP WHERE last_seen IS NULL AND first_seen IS NOT NULL;
    UPDATE companies SET last_seen=CURRENT_TIMESTAMP WHERE last_seen IS NULL AND first_seen IS NOT NULL;
    UPDATE jobs SET last_seen=CURRENT_TIMESTAMP WHERE last_seen IS NULL AND first_seen IS NOT NULL;
    INSERT OR IGNORE INTO kv (k,v) VALUES ('migrate:last_seen_backfill', CURRENT_TIMESTAMP);
    COMMIT;`);
}

/**
 * One-off: rows cached before savePeople normalised its key ("/in/x", "/in/x/pt", "/in/x?trk=") are merged into the
 * canonical https://www.linkedin.com/in/<slug>/ row (newest sighting wins, empty fields filled from the others), and a
 * "X e mais 23 conexões em comum" line saved as a name by the pre-0.5 card parser is cleared.
 */
export function canonicalisePeople(d: DatabaseSync) {
  type Row = { url: string; name: string | null; headline: string | null; company: string | null; role: string | null; location: string | null; degree: string | null; first_seen: string | null; last_seen: string | null };
  const FIELDS = ["name", "headline", "company", "role", "location", "degree"] as const;
  // Flag check and read inside the write lock: Desktop and several Code sessions may start servers on this db at
  // once, and a second run on rows read before the first one committed would hit the canonical row's PRIMARY KEY.
  d.exec("BEGIN IMMEDIATE");
  try {
    if (d.prepare(`SELECT 1 FROM kv WHERE k='migrate:people_url_canonical'`).get()) {
      d.exec("COMMIT");
      return;
    }
    const rows = d.prepare(`SELECT url,name,headline,company,role,location,degree,first_seen,last_seen FROM people`).all() as Row[];
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = normaliseProfileId(r.url) ?? r.url;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const [key, g] of groups) {
      if (g.length === 1 && g[0].url === key && !(g[0].name && isMutualText(g[0].name))) continue;
      g.sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""));
      const merged = { ...g[0] };
      for (const f of FIELDS) merged[f] = g.map((r) => r[f]).find((v) => !!v && !(f === "name" && isMutualText(v))) ?? null;
      merged.first_seen = g.map((r) => r.first_seen).filter(Boolean).sort()[0] ?? null;
      for (const r of g) d.prepare(`DELETE FROM people WHERE url=?`).run(r.url);
      d.prepare(`INSERT INTO people (url,name,headline,company,role,location,degree,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        key, merged.name, merged.headline, merged.company, merged.role, merged.location, merged.degree, merged.first_seen, merged.last_seen,
      );
    }
    d.exec(`INSERT OR IGNORE INTO kv (k,v) VALUES ('migrate:people_url_canonical', CURRENT_TIMESTAMP); COMMIT;`);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
if (!db.prepare(`SELECT 1 FROM kv WHERE k='migrate:people_url_canonical'`).get()) canonicalisePeople(db);

export type JobRow = {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  /** 1 = Easy Apply, 0 = external (confirmed on the job page), null = not known yet. */
  easy_apply: number | null;
  posted: string | null;
  description: string | null;
  applied: number;
  closed: number;
  apply_url: string | null;
  tracker_seen: number;
  enriched_at: string | null;
  modality: string | null;
  employment_type: string | null;
  applicants: string | null;
  /** JSON array of the poster's "Requisitos adicionados" bullets. */
  requirements: string | null;
  company_url: string | null;
  /** Keywords of the search that first found the job. */
  search_keywords: string | null;
  /** ISO timestamp derived from the first relative "posted" text seen (sighting time minus the offset). */
  posted_at: string | null;
  enrich_attempts: number | null;
  enrich_failed_at: string | null;
  first_seen: string | null;
};

const UNITS: [RegExp, number][] = [
  [/^(min|minutos?|minutes?)$/, 60e3],
  [/^(h|horas?|hours?|hrs?)$/, 3600e3],
  [/^(d|dias?|days?)$/, 86400e3],
  [/^(sem|semanas?|weeks?|w)$/, 7 * 86400e3],
  [/^(m[eê]s|meses|months?|mo)$/, 30 * 86400e3],
  [/^(anos?|years?|y)$/, 365 * 86400e3],
];
/** "Republicado há 2 dias" / "Anunciada há 3 d" / "2 days ago" -> ISO timestamp relative to `now`; "" when not a relative date. */
export function postedToIso(posted: string | null | undefined, now = new Date()): string {
  const m = (posted ?? "").toLowerCase().match(/h[aá]\s+(\d+)\s*([a-zê]+)|(\d+)\s*([a-z]+)\s+ago/);
  if (!m) return "";
  const n = Number(m[1] ?? m[3]);
  const unit = m[2] ?? m[4];
  const ms = UNITS.find(([re]) => re.test(unit))?.[1];
  return ms ? new Date(now.getTime() - n * ms).toISOString() : "";
}

/** Empty strings never overwrite stored values (NULLIF). `applied` only goes 0 -> 1; `closed` only goes 1 -> 0 via setClosed (job page). */
export function upsertJob(j: Partial<JobRow> & { id: string }) {
  db.prepare(
    `INSERT INTO jobs (id,title,company,location,url,easy_apply,posted,description,applied,closed,apply_url,posted_at,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       last_seen=CURRENT_TIMESTAMP,
       apply_url=COALESCE(NULLIF(excluded.apply_url,''),apply_url),
       title=COALESCE(NULLIF(excluded.title,''),title), company=COALESCE(NULLIF(excluded.company,''),company),
       location=COALESCE(NULLIF(excluded.location,''),location), url=COALESCE(NULLIF(excluded.url,''),url),
       easy_apply=CASE WHEN excluded.easy_apply IS NULL THEN easy_apply ELSE MAX(COALESCE(easy_apply,0),excluded.easy_apply) END, posted=COALESCE(NULLIF(excluded.posted,''),posted),
       posted_at=COALESCE(posted_at,NULLIF(excluded.posted_at,'')),
       description=COALESCE(NULLIF(excluded.description,''),description),
       applied=MAX(applied,excluded.applied), closed=MAX(closed,excluded.closed)`,
  ).run(
    j.id,
    j.title ?? null,
    j.company ?? null,
    j.location ?? null,
    j.url ?? null,
    j.easy_apply ?? null,
    j.posted ?? null,
    j.description ?? null,
    j.applied ?? 0,
    j.closed ?? 0,
    j.apply_url ?? null,
    j.posted_at || postedToIso(j.posted) || null,
  );
}

/** The job page is authoritative: a reopened/reposted job whose page shows an apply button is open again. */
export function setClosed(id: string, closed: boolean) {
  db.prepare(`UPDATE jobs SET closed=? WHERE id=?`).run(closed ? 1 : 0, id);
}

/**
 * Successful job-page read only (getJobDetail throws on blank/failed pages), so enriched_at is never stamped on failure.
 * An empty requirements list never replaces stored requirements.
 */
export function saveDetail(
  id: string,
  d: { modality: string; employment_type: string; applicants: string; requirements: string[]; company_url: string },
) {
  db.prepare(
    `UPDATE jobs SET enriched_at=CURRENT_TIMESTAMP,
       modality=COALESCE(NULLIF(?,''),modality), employment_type=COALESCE(NULLIF(?,''),employment_type),
       applicants=COALESCE(NULLIF(?,''),applicants), requirements=COALESCE(NULLIF(?,'[]'),requirements), company_url=COALESCE(NULLIF(?,''),company_url)
     WHERE id=?`,
  ).run(d.modality, d.employment_type, d.applicants, JSON.stringify(d.requirements), d.company_url, id);
}

/** Auto-enrich gives up on a job after this many failed job-page reads. */
export const MAX_ENRICH_ATTEMPTS = 3;
export function recordEnrichFailure(id: string) {
  db.prepare(`UPDATE jobs SET enrich_attempts=COALESCE(enrich_attempts,0)+1, enrich_failed_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
}
/** Unenriched open jobs for the jobs_enrich auto-pick, newest first, skipping ones that already failed MAX_ENRICH_ATTEMPTS times. */
export function listEnrichCandidates(): { id: string; title: string; company: string }[] {
  return db
    .prepare(
      `SELECT id, title, company FROM jobs WHERE enriched_at IS NULL AND applied=0 AND closed=0 AND COALESCE(enrich_attempts,0) < ? ORDER BY first_seen DESC`,
    )
    .all(MAX_ENRICH_ATTEMPTS) as { id: string; title: string; company: string }[];
}

/** Remember which search found the job (first one wins). */
export function setSearchKeywords(id: string, kw: string) {
  db.prepare(`UPDATE jobs SET search_keywords=COALESCE(search_keywords,?) WHERE id=?`).run(kw, id);
}
/** Seen on the jobs tracker (the source of truth for 'applied'), as opposed to a search-card flag. */
export function markTrackerSeen(id: string) {
  db.prepare(`UPDATE jobs SET tracker_seen=1 WHERE id=?`).run(id);
}

export function getJob(id: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
}

export function logAction(type: string, target: string, status: string, detail = "") {
  db.prepare(`INSERT INTO actions (type,target,status,detail) VALUES (?,?,?,?)`).run(type, target, status, detail);
}

export function kvGet(k: string): string | undefined {
  return (db.prepare(`SELECT v FROM kv WHERE k=?`).get(k) as { v: string } | undefined)?.v;
}
export function kvSet(k: string, v: string | null) {
  if (v === null) db.prepare(`DELETE FROM kv WHERE k=?`).run(k);
  else db.prepare(`INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v);
}

/**
 * Atomically takes one unit of today's read budget for `kind` (a single statement, safe across the Code and
 * Desktop servers sharing this db). False when the limit is reached. A corrupted stored value is reset, not thrown on.
 * `kind` is an internal constant, never user input.
 */
export function claimRead(day: string, kind: string, limit: number): boolean {
  const p = `$.${kind}`;
  const safe = `CASE WHEN json_valid(v) THEN v ELSE '{}' END`;
  const cur = `COALESCE(json_extract(${safe}, ?), 0)`;
  const row = db
    .prepare(
      `INSERT INTO kv (k,v) VALUES (?, json_object(?, 1))
       ON CONFLICT(k) DO UPDATE SET v=json_set(${safe}, ?, ${cur}+1) WHERE ${cur} < ?
       RETURNING v`,
    )
    .get(`reads:${day}`, kind, p, p, p, limit);
  return !!row;
}
/** Gives back a unit taken by claimRead (the navigation failed before LinkedIn answered). */
export function refundRead(day: string, kind: string) {
  const p = `$.${kind}`;
  db.prepare(`UPDATE kv SET v=json_set(v, ?, MAX(COALESCE(json_extract(v, ?), 0) - 1, 0)) WHERE k=? AND json_valid(v)`).run(p, p, `reads:${day}`);
}
export function readCounts(day: string): Record<string, number> {
  try {
    const o = JSON.parse(kvGet(`reads:${day}`) ?? "{}");
    return o && typeof o === "object" ? (o as Record<string, number>) : {};
  } catch {
    return {};
  }
}
