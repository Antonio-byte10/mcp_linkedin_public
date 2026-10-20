// npm run migrate-data on temp folders: an old-layout code folder (data/ with a WAL-mode SQLite db, browser profiles)
// moved into a separate data folder. Never touches the real code or data folders, never launches a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { copyVerified, groupDb, migrateLegacyData } from "../src/store/migrateData.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-mig2-"));
const write = (p: string, body = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

/** Old layout: data/ (db in WAL mode with an un-checkpointed row, answers, exports) and .edge-profile/. */
function oldLayout(root: string) {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "data", "linkedin.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE people (url TEXT); INSERT INTO people VALUES ('https://www.linkedin.com/in/x/');");
  db.close();
  write(path.join(root, "data", "answers.json"), "{}");
  write(path.join(root, "data", "exports", "vagas.xlsx"));
  write(path.join(root, ".edge-profile", "Default", "Cookies"), "c".repeat(1000));
  write(path.join(root, ".edge-profile", "Local State"), "{}");
}

test("groupDb: linkedin.db and its -wal/-shm move together", () => {
  assert.deepEqual(groupDb(["answers.json", "linkedin.db-wal", "linkedin.db", "linkedin.db-shm", "exports"]), [
    ["linkedin.db", "linkedin.db-shm", "linkedin.db-wal"], ["answers.json"], ["exports"],
  ]);
  assert.deepEqual(groupDb(["answers.json"]), [["answers.json"]]);
});

test("moves data/* and the profile, keeps the db rows, removes the old folders", () => {
  const root = tmp();
  const dataDir = path.join(tmp(), "mcp-linkedin");
  oldLayout(root);
  const r = migrateLegacyData({ root, dataDir, profileLocked: () => false });
  assert.deepEqual(r.skipped, []);
  assert.ok(r.moved.some((m) => m.startsWith(path.join("data", "linkedin.db"))));
  assert.ok(r.moved.includes(".edge-profile"));
  assert.ok(!fs.existsSync(path.join(root, "data")) && !fs.existsSync(path.join(root, ".edge-profile")));
  assert.equal(fs.readFileSync(path.join(dataDir, "edge-profile", "Default", "Cookies"), "utf8").length, 1000);
  assert.ok(fs.existsSync(path.join(dataDir, "answers.json")) && fs.existsSync(path.join(dataDir, "exports", "vagas.xlsx")));
  const db = new DatabaseSync(path.join(dataDir, "linkedin.db"));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM people").get() as { n: number }).n, 1, "the WAL row was folded in");
  db.close();
  // a second run finds nothing to do
  assert.deepEqual(migrateLegacyData({ root, dataDir, profileLocked: () => false }), { moved: [], skipped: [] });
});

test("never overwrites: an existing item in the data folder is skipped and its source kept", () => {
  const root = tmp();
  const dataDir = tmp();
  oldLayout(root);
  write(path.join(dataDir, "answers.json"), '{"mine":true}');
  fs.mkdirSync(path.join(dataDir, "exports")); // an empty folder is fine to replace
  const r = migrateLegacyData({ root, dataDir, profileLocked: () => false });
  assert.deepEqual(r.skipped.map((s) => s.item), [path.join("data", "answers.json")]);
  assert.equal(fs.readFileSync(path.join(dataDir, "answers.json"), "utf8"), '{"mine":true}');
  assert.ok(fs.existsSync(path.join(root, "data", "answers.json")), "source kept");
  assert.ok(fs.existsSync(path.join(dataDir, "exports", "vagas.xlsx")));
});

test("a profile in use is not moved; the data folder equal to the code folder is a no-op", () => {
  const root = tmp();
  const dataDir = tmp();
  oldLayout(root);
  const r = migrateLegacyData({ root, dataDir, profileLocked: (d) => d.endsWith(".edge-profile") });
  assert.deepEqual(r.skipped.map((s) => s.item), [".edge-profile"]);
  assert.ok(fs.existsSync(path.join(root, ".edge-profile", "Local State")));
  assert.deepEqual(migrateLegacyData({ root, dataDir: root, profileLocked: () => false }), { moved: [], skipped: [] });
});

test("copyVerified (cross-drive path): a leftover .mcp-partial from an interrupted run is replaced; source removed only after the check", () => {
  const root = tmp();
  const src = path.join(root, "profile");
  write(path.join(src, "Default", "Cookies"), "c".repeat(500));
  write(path.join(src, "Local State"), "{}");
  const dst = path.join(tmp(), "edge-profile");
  write(path.join(`${dst}.mcp-partial`, "stale"), "half"); // what an interrupted copy leaves
  copyVerified(src, dst);
  assert.ok(!fs.existsSync(src) && !fs.existsSync(`${dst}.mcp-partial`));
  assert.equal(fs.readFileSync(path.join(dst, "Default", "Cookies"), "utf8").length, 500);
  assert.ok(!fs.existsSync(path.join(dst, "stale")));
});

test("paths the current configuration uses are left in place", () => {
  const root = tmp();
  const dataDir = tmp();
  oldLayout(root);
  const r = migrateLegacyData({ root, dataDir, inUse: [path.join(root, ".edge-profile")], profileLocked: () => false });
  assert.deepEqual(r.skipped.map((s) => s.item), [".edge-profile"]);
  assert.match(r.skipped[0].reason, /BROWSER_PROFILE_DIR/);
  assert.ok(fs.existsSync(path.join(root, ".edge-profile", "Local State")));
});
