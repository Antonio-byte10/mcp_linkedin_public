// Schema upgrade on a temp SQLite file written in the pre-0.5 shape (no last_seen): the one-off backfill (no browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-mig-"));
const file = path.join(tmp, "data.db");
const old = new DatabaseSync(file);
old.exec(`
CREATE TABLE people (url TEXT PRIMARY KEY, name TEXT, headline TEXT, company TEXT, location TEXT, degree TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE companies (url TEXT PRIMARY KEY, name TEXT, industry TEXT, size TEXT, website TEXT, location TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO people (url,name,first_seen) VALUES ('https://www.linkedin.com/in/seen-before/','A','2025-01-01 00:00:00'), ('https://www.linkedin.com/in/no-age/','B',NULL);
INSERT INTO companies (url,name,first_seen) VALUES ('c1','Old Co','2025-01-01 00:00:00');
INSERT INTO people (url,name,headline,degree,first_seen) VALUES
  ('https://www.linkedin.com/in/dup-person','Dup Person',NULL,'1°','2025-02-01 00:00:00'),
  ('https://www.linkedin.com/in/dup-person/pt',NULL,'Data Analyst','','2025-03-01 00:00:00'),
  ('https://www.linkedin.com/in/mutual-name','Ana Silva, Bruno Lima e mais 23 conexões em comum','Recruiter','2º','2025-03-01 00:00:00');
`);
old.close();
process.env.LINKEDIN_DB = file;

const { db } = await import("../src/store/db.js");
const { purgeOld } = await import("../src/store/purge.js");

test("rows cached before last_seen get it once; unknown age stays unknown; the first purge deletes nothing", () => {
  const p = db.prepare(`SELECT url, last_seen FROM people ORDER BY url`).all() as { url: string; last_seen: string | null }[];
  assert.ok(p.find((r) => r.url.includes("seen-before"))?.last_seen);
  assert.equal(p.find((r) => r.url.includes("no-age"))?.last_seen, null);
  assert.ok((db.prepare(`SELECT last_seen FROM companies`).get() as { last_seen: string | null }).last_seen);
  assert.ok(db.prepare(`SELECT 1 FROM kv WHERE k='migrate:last_seen_backfill'`).get());
  const r = purgeOld(db, 30, ["people", "companies"], true);
  assert.equal(r.people, 0);
  assert.equal(r.companies, 0);
});

test("people urls are canonicalised once: spellings merged, a mutual-connections 'name' cleared", () => {
  const rows = db.prepare(`SELECT url,name,headline,degree,first_seen FROM people WHERE url LIKE '%dup-person%' OR url LIKE '%mutual-name%' ORDER BY url`).all() as Record<string, string | null>[];
  assert.deepEqual(rows.map((r) => r.url), ["https://www.linkedin.com/in/dup-person/", "https://www.linkedin.com/in/mutual-name/"]);
  assert.deepEqual([rows[0].name, rows[0].headline, rows[0].degree, rows[0].first_seen], ["Dup Person", "Data Analyst", "1°", "2025-02-01 00:00:00"]);
  assert.deepEqual([rows[1].name, rows[1].headline], [null, "Recruiter"]);
  assert.ok(db.prepare(`SELECT 1 FROM kv WHERE k='migrate:people_url_canonical'`).get());
});

test("people canonicalisation runs once even when called again (concurrent servers): no PRIMARY KEY error", async () => {
  const { canonicalisePeople } = await import("../src/store/db.js");
  db.prepare(`INSERT INTO people (url,name) VALUES ('https://www.linkedin.com/in/late-dup/pt','Late')`).run();
  canonicalisePeople(db); // flag already set: a no-op, inside the lock
  assert.ok(db.prepare(`SELECT 1 FROM people WHERE url='https://www.linkedin.com/in/late-dup/pt'`).get());
  db.prepare(`DELETE FROM kv WHERE k='migrate:people_url_canonical'`).run();
  canonicalisePeople(db);
  canonicalisePeople(db);
  assert.ok(db.prepare(`SELECT 1 FROM people WHERE url='https://www.linkedin.com/in/late-dup/'`).get());
  assert.equal(db.prepare(`SELECT count(*) n FROM people WHERE url LIKE '%late-dup%'`).get()!.n, 1);
});
