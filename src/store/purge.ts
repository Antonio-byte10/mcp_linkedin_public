import type { DatabaseSync } from "node:sqlite";
import { normaliseProfileId } from "../linkedin/writeRules.js";

export type PurgeScope = "people" | "companies" | "jobs";
export type PurgeResult = { dry_run: boolean; older_than_days: number; batches: number } & Partial<Record<PurgeScope, number>>;

/** People we contacted this recently keep their cache row (the connect/message history still points at them). */
export const CONTACT_PROTECT_DAYS = 90;

/**
 * LGPD purge of cached LinkedIn data older than `days`. Age = last sighting (COALESCE(last_seen, first_seen); rows with
 * no timestamp at all are kept). Never touches `actions` (the quota ledger); applied jobs, jobs with any apply action
 * and jobs in an open batch stay. Batches older than `days` (names, note previews, message texts in their meta) always
 * go: days >= 1 puts them far past the 30-min batch TTL, so no executable batch is ever deleted. dry_run only counts.
 */
export function purgeOld(d: DatabaseSync, days: number, scope: PurgeScope[], dryRun: boolean): PurgeResult {
  const cutoff = `-${Math.floor(days)} day`;
  if (!(days >= 1)) throw new Error("older_than_days must be at least 1");
  const out: PurgeResult = { dry_run: dryRun, older_than_days: days, batches: 0 };
  d.exec("BEGIN");
  try {
    for (const s of new Set(scope)) {
      const doomed = s === "people" ? oldPeople(d, cutoff) : s === "companies" ? oldCompanies(d, cutoff) : oldJobs(d, cutoff);
      out[s] = doomed.ids.length;
      if (dryRun) continue;
      const del = d.prepare(`DELETE FROM ${s} WHERE ${doomed.key}=?`);
      for (const id of doomed.ids) del.run(id);
    }
    // after oldJobs: it reads open batches to protect their jobs
    const oldBatches = `FROM batches WHERE created_at < datetime('now', ?)`;
    out.batches = (d.prepare(`SELECT COUNT(*) AS n ${oldBatches}`).get(cutoff) as { n: number }).n;
    if (!dryRun) d.prepare(`DELETE ${oldBatches}`).run(cutoff);
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch { /* best effort: never mask the original error */ }
    throw e;
  }
  return out;
}

/**
 * Opt-in startup purge (LINKEDIN_AUTO_PURGE_DAYS): people and companies unseen for `days`, plus old batches, same rules as
 * data_purge with dry_run false. days <= 0 does nothing. Logs only when something went; never throws (a failed purge must
 * not stop the server from starting).
 */
export function runAutoPurge(d: DatabaseSync, days: number, log: (m: string) => void): PurgeResult | undefined {
  if (!(days > 0)) return undefined;
  try {
    const r = purgeOld(d, days, ["people", "companies"], false);
    if (r.people || r.companies || r.batches) {
      log(`mcp-linkedin: auto-purge (>${days} days): ${r.people ?? 0} people, ${r.companies ?? 0} companies, ${r.batches} batches removed`);
    }
    return r;
  } catch (e) {
    log(`mcp-linkedin: auto-purge failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

type Doomed = { key: string; ids: string[] };
const col = (rows: unknown[], k: string) => (rows as Record<string, string>[]).map((r) => r[k]);

function oldCompanies(d: DatabaseSync, cutoff: string): Doomed {
  const rows = d.prepare(`SELECT url FROM companies WHERE COALESCE(last_seen, first_seen) < datetime('now', ?)`).all(cutoff);
  return { key: "url", ids: col(rows, "url") };
}

function oldPeople(d: DatabaseSync, cutoff: string): Doomed {
  // actions.target holds the normalised profile URL; people.url may be stored differently, so compare normalised.
  const targets = d.prepare(`SELECT DISTINCT target FROM actions WHERE type IN ('connect','message') AND ts >= datetime('now', ?)`).all(`-${CONTACT_PROTECT_DAYS} day`);
  const contacted = new Set(col(targets, "target").filter(Boolean).map((t) => normaliseProfileId(t) ?? t));
  const rows = d.prepare(`SELECT url FROM people WHERE COALESCE(last_seen, first_seen) < datetime('now', ?)`).all(cutoff);
  return { key: "url", ids: col(rows, "url").filter((u) => !contacted.has(normaliseProfileId(u) ?? u)) };
}

function oldJobs(d: DatabaseSync, cutoff: string): Doomed {
  // Open-batch ids: substring match is deliberately conservative (a false hit only keeps a row).
  const open = col(d.prepare(`SELECT items FROM batches WHERE used=0`).all(), "items").join("\n");
  const applyTargets = new Set(col(d.prepare(`SELECT DISTINCT target FROM actions WHERE type='apply'`).all(), "target"));
  // Most recent activity: a re-seen or recently enriched job is not old. '' = no timestamps at all -> keep.
  const last = `MAX(COALESCE(last_seen,''), COALESCE(enriched_at,''), COALESCE(first_seen,''))`;
  const rows = d.prepare(`SELECT id FROM jobs WHERE applied=0 AND ${last} <> '' AND ${last} < datetime('now', ?)`).all(cutoff);
  return { key: "id", ids: col(rows, "id").filter((id) => !applyTargets.has(id) && !open.includes(id)) };
}
