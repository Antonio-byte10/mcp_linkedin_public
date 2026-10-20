import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_DATA, samePath } from "../config.js";

// Moves data an older version kept in the code folder into the data folder (npm run migrate-data).
// No browser and no store/db.ts: importing it here would create an empty linkedin.db in the target before the real one arrives.

export type MigrationResult = { moved: string[]; skipped: { item: string; reason: string }[] };

const isEmptyDir = (p: string) => fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

/** Files and total bytes under `p` (a copy is accepted only when both match the source). */
function tally(p: string): { files: number; bytes: number } {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.isFile() ? st.size : 0 };
  return fs.readdirSync(p).reduce(
    (t, e) => {
      const x = tally(path.join(p, e));
      return { files: t.files + x.files, bytes: t.bytes + x.bytes };
    },
    { files: 0, bytes: 0 },
  );
}

/** rename; across drives (code on D:, %LOCALAPPDATA% on C:) copyVerified. */
function move(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  copyVerified(src, dst);
}

/**
 * Copy, verify (file count and bytes), then delete the source. Copied under a temporary name and renamed only once
 * verified: an interrupted run leaves a ".mcp-partial" (replaced on the next run), never a half copy under the real name.
 */
export function copyVerified(src: string, dst: string) {
  const partial = `${dst}.mcp-partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.cpSync(src, partial, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  const a = tally(src);
  const b = tally(partial);
  if (a.files !== b.files || a.bytes !== b.bytes) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error(`copy check failed (${a.files} files/${a.bytes} bytes vs ${b.files}/${b.bytes}); the source was kept`);
  }
  fs.renameSync(partial, dst);
  fs.rmSync(src, { recursive: true, force: true });
}

/** Folds the WAL into linkedin.db (closing the last connection removes -wal/-shm), so the file stands alone. */
function checkpoint(dbFile: string) {
  if (!fs.existsSync(dbFile)) return;
  const d = new DatabaseSync(dbFile);
  try {
    d.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    d.close();
  }
}

/** Directory entries as move units: linkedin.db and its -wal/-shm together, everything else alone. */
export function groupDb(entries: string[]): string[][] {
  const db = entries.filter((e) => /^linkedin\.db(-wal|-shm)?$/.test(e)).sort();
  return [...(db.length ? [db] : []), ...entries.filter((e) => !db.includes(e)).map((e) => [e])];
}

/**
 * Something keeps files open in `dir` (Windows: a running server holds linkedin.db, a browser its profile)?
 * Renaming the folder in place fails then; it is renamed straight back. Elsewhere renames succeed even with
 * open files, so callers also check the browser lock.
 */
function inUse(dir: string): boolean {
  const probe = `${dir}.mcp-migrating`;
  try {
    fs.renameSync(dir, probe);
  } catch (e) {
    return ["EBUSY", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "");
  }
  try {
    fs.renameSync(probe, dir);
  } catch (e) {
    throw new Error(`could not rename ${probe} back to ${dir} (${(e as Error).message}): rename it by hand before using the MCP`);
  }
  return false;
}

/**
 * Moves root/data/* into dataDir and root/.edge-profile, root/.chrome-profile into dataDir/edge-profile,
 * dataDir/chrome-profile. Never overwrites: a unit with anything already in the data folder (other than an empty
 * folder) is skipped and reported, and so is a whole folder that is in use.
 */
export function migrateLegacyData(o: { root: string; dataDir: string; inUse?: string[]; profileLocked: (dir: string) => boolean }): MigrationResult {
  const out: MigrationResult = { moved: [], skipped: [] };
  if (samePath(o.root, o.dataDir)) return out;
  const used = [o.dataDir, ...(o.inUse ?? [])];
  fs.mkdirSync(o.dataDir, { recursive: true });
  for (const { from, to } of LEGACY_DATA) {
    const src = path.join(o.root, from);
    if (!fs.existsSync(src)) continue;
    // the current configuration still points here (LINKEDIN_DATA_DIR / BROWSER_PROFILE_DIR / LINKEDIN_DB): leave it
    if (used.some((u) => samePath(u, src))) {
      out.skipped.push({ item: from, reason: "the current configuration uses it here (LINKEDIN_DATA_DIR / BROWSER_PROFILE_DIR / LINKEDIN_DB); left in place" });
      continue;
    }
    const isProfile = to !== ".";
    if ((isProfile && o.profileLocked(src)) || inUse(src)) {
      out.skipped.push({ item: from, reason: "in use: close Claude Desktop/Code (and any MCP browser window) and run again" });
      continue;
    }
    if (!isProfile) {
      try {
        checkpoint(path.join(src, "linkedin.db"));
      } catch (e) {
        out.skipped.push({ item: from, reason: `linkedin.db could not be checkpointed (${firstLine(e)}); nothing moved` });
        continue;
      }
    }
    // linkedin.db with its -wal/-shm is one unit: a WAL must never end up next to another database
    const units = isProfile ? [[from]] : groupDb(fs.readdirSync(src));
    for (const names of units) {
      const pairs = names.map((n) => (isProfile ? [src, path.join(o.dataDir, to)] : [path.join(src, n), path.join(o.dataDir, n)]));
      const item = path.relative(o.root, pairs[0][0]) + (names.length > 1 ? ` (+${names.length - 1})` : "");
      const taken = pairs.find(([, d]) => fs.existsSync(d) && !isEmptyDir(d));
      if (taken) {
        out.skipped.push({ item, reason: `already exists in the data folder (${taken[1]}); nothing overwritten` });
        continue;
      }
      try {
        for (const [s, d] of pairs) {
          if (fs.existsSync(d)) fs.rmdirSync(d);
          move(s, d);
        }
        out.moved.push(item);
      } catch (e) {
        out.skipped.push({ item, reason: firstLine(e) });
      }
    }
    if (!isProfile && fs.existsSync(src) && fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  }
  return out;
}
