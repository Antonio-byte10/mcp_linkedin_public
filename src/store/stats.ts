import type { DatabaseSync } from "node:sqlite";
import { analyzeJob, type Seniority } from "../analysis/match.js";
import { clip } from "../guard/untrusted.js";
import type { JobRow } from "./db.js";

const WINDOWS: [string, string][] = [["last_24h", "-1 day"], ["last_7d", "-7 day"], ["last_30d", "-30 day"]];

/**
 * Read-only summary of the local pipeline: cached jobs, match levels, quota ledger activity, skill gaps, top companies.
 * Counts cover the whole cache; the analysis (match levels, skill gaps, top companies) leaves out excluded companies
 * (answers.json target.excluded_companies, e.g. the current employer), like jobs_list_local.
 */
export function pipelineStats(d: DatabaseSync, userSkills: Set<string>, targetSen: Set<Seniority>, excluded: (company: string | null) => boolean = () => false) {
  const n = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
  const all = d.prepare(`SELECT * FROM jobs`).all() as unknown as JobRow[];
  const jobs = all.filter((j) => !excluded(j.company));

  const by_match_level: Record<string, number> = {};
  const missing = new Map<string, number>();
  for (const j of jobs) {
    const m = analyzeJob(j, userSkills, targetSen);
    by_match_level[m.match_level] = (by_match_level[m.match_level] ?? 0) + 1;
    // Skill gaps only where they are actionable: open, not yet applied, a real fit (Alto/Médio).
    if (j.closed || j.applied || (m.match_level !== "Alto" && m.match_level !== "Médio")) continue;
    for (const s of m.skills_missing) missing.set(s, (missing.get(s) ?? 0) + 1);
  }

  const actions: Record<string, Record<string, Record<string, number>>> = {};
  for (const [label, off] of WINDOWS) {
    const rows = d.prepare(`SELECT type, status, COUNT(*) AS n FROM actions WHERE ts >= datetime('now', ?) GROUP BY type, status`).all(off) as { type: string; status: string | null; n: number }[];
    const w: Record<string, Record<string, number>> = {};
    for (const r of rows) (w[r.type] ??= {})[r.status ?? "unknown"] = r.n;
    actions[label] = w;
  }

  // Names come from LinkedIn: clipped before they leave the module.
  const top = (m: Map<string, number>, key: string) =>
    [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([name, count]) => ({ [key]: clip(name, 100), count }));
  const companies = new Map<string, number>();
  for (const j of jobs) {
    const c = j.company?.trim();
    if (c) companies.set(c, (companies.get(c) ?? 0) + 1);
  }

  return {
    jobs: {
      cached: all.length,
      excluded_companies_jobs: all.length - jobs.length,
      enriched: n(`SELECT COUNT(*) AS n FROM jobs WHERE enriched_at IS NOT NULL`),
      easy_apply: n(`SELECT COUNT(*) AS n FROM jobs WHERE easy_apply=1`),
      external: n(`SELECT COUNT(*) AS n FROM jobs WHERE easy_apply=0`),
      apply_type_unknown: n(`SELECT COUNT(*) AS n FROM jobs WHERE easy_apply IS NULL`),
      applied: n(`SELECT COUNT(*) AS n FROM jobs WHERE applied=1`),
      // No per-stage column exists; tracker_seen marks jobs confirmed on the LinkedIn tracker.
      applied_confirmed_by_tracker: n(`SELECT COUNT(*) AS n FROM jobs WHERE applied=1 AND tracker_seen=1`),
      by_match_level,
    },
    actions,
    top_missing_skills: top(missing, "skill"),
    top_companies: top(companies, "company"),
  };
}
