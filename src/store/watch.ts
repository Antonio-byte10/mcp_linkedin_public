import type { DatabaseSync } from "node:sqlite";

export const MAX_SAVED_SEARCHES = 20; // keeps one jobs_watch_run inside the daily read budget

export type SavedSearch = { name: string; params: Record<string, unknown>; created_at: string; last_run_at: string | null };

export function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 60) throw new Error("Search name must be 1..60 characters.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error("Search name must not contain control characters.");
  return name;
}

/** Upsert; a new name beyond the cap is rejected, updating an existing one never is. */
export function saveSearch(db: DatabaseSync, rawName: string, params: Record<string, unknown>): string {
  const name = cleanName(rawName);
  const exists = db.prepare(`SELECT 1 FROM saved_searches WHERE name=?`).get(name);
  if (!exists) {
    const n = (db.prepare(`SELECT COUNT(*) n FROM saved_searches`).get() as { n: number }).n;
    if (n >= MAX_SAVED_SEARCHES) throw new Error(`At most ${MAX_SAVED_SEARCHES} saved searches; delete one with jobs_watch_delete first.`);
  }
  db.prepare(
    `INSERT INTO saved_searches (name, params) VALUES (?,?)
     ON CONFLICT(name) DO UPDATE SET params=excluded.params`,
  ).run(name, JSON.stringify(params));
  return name;
}

export function listSearches(db: DatabaseSync): SavedSearch[] {
  const rows = db.prepare(`SELECT name, params, created_at, last_run_at FROM saved_searches ORDER BY created_at, name`).all() as
    { name: string; params: string; created_at: string; last_run_at: string | null }[];
  return rows.map((r) => ({ ...r, params: JSON.parse(r.params) }));
}

export function deleteSearch(db: DatabaseSync, name: string): boolean {
  return Number(db.prepare(`DELETE FROM saved_searches WHERE name=?`).run(name.trim()).changes) > 0;
}

export function markRun(db: DatabaseSync, name: string) {
  db.prepare(`UPDATE saved_searches SET last_run_at=CURRENT_TIMESTAMP WHERE name=?`).run(name);
}

/** Jobs whose id was not in `knownBefore` (snapshot taken before the search cached its results). */
export function onlyNew<T extends { id: string }>(jobs: T[], knownBefore: ReadonlySet<string>): T[] {
  return jobs.filter((j) => !knownBefore.has(j.id));
}

export type WatchDeps<R> = {
  search: (s: SavedSearch) => Promise<R>;
  hasTime: (needMs: number) => boolean;
  isAccountError: (msg: string) => boolean;
  markRun: (name: string) => void;
};
export const PER_SEARCH_MS = 12000; // one first-page read; hasTime(30000) can never hold with the default call budget

/** Sequential run. The first search always runs; later ones need time. Account-level errors end the loop. */
export async function runWatch<R>(searches: SavedSearch[], d: WatchDeps<R>) {
  const results: { name: string; result: R }[] = [];
  const errors: { name: string; error: string }[] = [];
  let stopped: string | undefined;
  let i = 0;
  for (; i < searches.length; i++) {
    if (i > 0 && !d.hasTime(PER_SEARCH_MS)) break;
    const s = searches[i];
    try {
      const result = await d.search(s);
      d.markRun(s.name);
      results.push({ name: s.name, result });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (d.isAccountError(msg)) {
        stopped = msg;
        break;
      }
      errors.push({ name: s.name, error: msg });
    }
  }
  // the loop ran searches[0..i-1]; on a stop, searches[i] did not finish and is left too
  return { results, errors, stopped, left: searches.slice(i).map((s) => s.name) };
}
