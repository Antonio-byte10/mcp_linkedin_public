// Local data tools: data_purge (LGPD) and pipeline_stats on a temp SQLite file (never data/linkedin.db, no browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-t4-"));
process.env.LINKEDIN_DB = path.join(tmp, "data.db");

const { db, upsertJob } = await import("../src/store/db.js");
const { purgeOld, runAutoPurge } = await import("../src/store/purge.js");
const { pipelineStats } = await import("../src/store/stats.js");
const { savePeople } = await import("../src/linkedin/people.js");

const ago = (days: number) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 19).replace("T", " ");
const person = (slug: string, first: string | null, last: string | null) =>
  db.prepare(`INSERT INTO people (url,name,first_seen,last_seen) VALUES (?,?,?,?)`).run(`https://www.linkedin.com/in/${slug}/`, slug, first, last);
const count = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

test("people: age uses last_seen, NULL age kept, recent contact protected, dry run deletes nothing", () => {
  person("old-unseen", ago(400), null);
  person("old-reseen", ago(400), ago(2));
  person("no-age", null, null);
  person("contacted", ago(400), ago(300));
  db.prepare(`INSERT INTO actions (type,target,status,ts) VALUES ('connect','https://www.linkedin.com/in/contacted/','done',?)`).run(ago(10));
  assert.equal(purgeOld(db, 30, ["people"], true).people, 1);
  assert.equal(count("people"), 4);
  assert.equal(purgeOld(db, 30, ["people"], false).people, 1);
  const left = (db.prepare(`SELECT name FROM people ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(left, ["contacted", "no-age", "old-reseen"]);
  assert.equal(count("actions"), 1);
});

test("savePeople re-sighting refreshes last_seen", () => {
  db.prepare(`UPDATE people SET last_seen=? WHERE name='old-reseen'`).run(ago(200));
  assert.equal(purgeOld(db, 30, ["people"], true).people, 1);
  savePeople([{ url: "https://www.linkedin.com/in/old-reseen/", name: "old-reseen", headline: "", company: "", role: "", location: "", degree: "", current: "", mutual: "", action: "" }]);
  assert.equal(purgeOld(db, 30, ["people"], true).people, 0);
});

test("companies purged by age; jobs only in scope and unprotected", () => {
  db.prepare(`INSERT INTO companies (url,name,first_seen,last_seen) VALUES ('c1','Old Co',?,NULL),('c2','Seen Co',?,?)`).run(ago(500), ago(500), ago(1));
  for (const id of ["100000001", "100000002", "100000003", "100000004", "100000005", "100000006"]) upsertJob({ id, title: `t${id}`, company: "Acme" });
  db.prepare(`UPDATE jobs SET first_seen=?, last_seen=NULL`).run(ago(400));
  db.prepare(`UPDATE jobs SET applied=1 WHERE id='100000002'`).run();
  db.prepare(`INSERT INTO actions (type,target,status) VALUES ('apply','100000003','failed')`).run(); // any apply status protects the job
  db.prepare(`INSERT INTO batches (id,kind,items,used) VALUES ('b1','apply','[{"id":"100000004"}]',0),('b2','apply','[{"id":"100000005"}]',1)`).run();
  db.prepare(`UPDATE jobs SET enriched_at=? WHERE id='100000006'`).run(ago(1));
  assert.equal(purgeOld(db, 30, ["people", "companies"], false).companies, 1);
  assert.equal(count("jobs"), 6); // jobs are not in the default scope
  assert.equal(purgeOld(db, 30, ["jobs"], false).jobs, 2); // 100000001 and 100000005 (its batch is used)
  const ids = (db.prepare(`SELECT id FROM jobs ORDER BY id`).all() as { id: string }[]).map((x) => x.id);
  assert.deepEqual(ids, ["100000002", "100000003", "100000004", "100000006"]);
  assert.equal(count("batches"), 2);
});

test("batches older than N days are purged (any kind, any state); recent ones and actions stay", () => {
  db.prepare(`INSERT INTO batches (id,kind,items,used,created_at) VALUES ('old-msg','message',?,0,?),('old-conn','connect','{"ids":[],"state":{}}',1,?)`).run(
    JSON.stringify({ ids: ["https://www.linkedin.com/in/x/"], state: {}, meta: { text: "Oi", names: { x: "X" } } }), ago(40), ago(31),
  );
  const actions = count("actions");
  const dry = purgeOld(db, 30, ["people"], true);
  assert.equal(dry.batches, 2);
  assert.equal(count("batches"), 4);
  assert.equal(purgeOld(db, 30, ["people"], false).batches, 2);
  assert.deepEqual((db.prepare(`SELECT id FROM batches ORDER BY id`).all() as { id: string }[]).map((x) => x.id), ["b1", "b2"]);
  assert.equal(count("actions"), actions);
  assert.throws(() => purgeOld(db, 0, ["people"], true));
});

test("pipeline_stats aggregates jobs, actions, skills and companies", () => {
  db.prepare(`UPDATE jobs SET easy_apply=1, enriched_at=CURRENT_TIMESTAMP, description='Requisitos: Python, SQL, Docker, Kubernetes' WHERE id='100000004'`).run();
  db.prepare(`UPDATE jobs SET easy_apply=0 WHERE id='100000003'`).run();
  db.prepare(`INSERT INTO actions (type,target,status) VALUES ('connect','x','done'),('connect','y','unverified')`).run();
  const s = pipelineStats(db, new Set(["python"]), new Set());
  assert.equal(s.jobs.cached, 4);
  assert.ok(s.jobs.enriched >= 1);
  assert.equal(s.jobs.easy_apply, 1);
  assert.equal(s.jobs.external, 1);
  assert.equal(s.jobs.applied, 1);
  assert.equal(s.actions.last_24h.connect.done, 1);
  assert.equal(s.actions.last_24h.connect.unverified, 1);
  assert.equal(s.actions.last_24h.apply.failed, 1);
  assert.deepEqual(s.top_companies, [{ company: "Acme", count: 4 }]);
  assert.ok(Array.isArray(s.top_missing_skills));
  // every analysed job lands in exactly one match level
  assert.equal(Object.values(s.jobs.by_match_level).reduce((a, b) => a + b, 0), s.jobs.cached);
  assert.equal(s.jobs.excluded_companies_jobs, 0);
});

test("pipeline_stats leaves excluded companies out of the analysis, not out of the counts", () => {
  upsertJob({ id: "100000099", title: "Analista de Dados", company: "Empregador Atual" });
  const s = pipelineStats(db, new Set(["python"]), new Set(), (c) => c === "Empregador Atual");
  assert.equal(s.jobs.cached, 5);
  assert.equal(s.jobs.excluded_companies_jobs, 1);
  assert.equal(Object.values(s.jobs.by_match_level).reduce((a, b) => a + b, 0), 4);
  assert.ok(!s.top_companies.some((c) => c.company === "Empregador Atual"));
});

test("runAutoPurge: 0 or less is off and touches nothing", () => {
  person("auto-old-off", ago(400), ago(400));
  const before = count("people");
  const logs: string[] = [];
  assert.equal(runAutoPurge(db, 0, (m) => logs.push(m)), undefined);
  assert.equal(runAutoPurge(db, -3, (m) => logs.push(m)), undefined);
  assert.equal(count("people"), before);
  assert.deepEqual(logs, []);
});

test("runAutoPurge: deletes old people/companies like purgeOld, keeps recent and contact-protected, logs once", () => {
  person("auto-recent", ago(400), ago(2));
  person("auto-contacted", ago(400), ago(300));
  db.prepare(`INSERT INTO actions (type,target,status,ts) VALUES ('message','https://www.linkedin.com/in/auto-contacted/','done',?)`).run(ago(5));
  db.prepare(`INSERT INTO companies (url,name,first_seen,last_seen) VALUES ('auto-c-old','Old',?,?),('auto-c-new','New',?,?)`).run(ago(500), ago(500), ago(500), ago(1));
  db.prepare(`INSERT INTO batches (id,kind,items,used,created_at) VALUES ('auto-old-batch','message','{}',1,?)`).run(ago(60));
  const logs: string[] = [];
  const r = runAutoPurge(db, 30, (m) => logs.push(m));
  assert.deepEqual([r?.people, r?.companies, r?.batches, r?.dry_run], [1, 1, 1, false]); // auto-old-off, Old, auto-old-batch
  assert.deepEqual(logs, ["mcp-linkedin: auto-purge (>30 days): 1 people, 1 companies, 1 batches removed"]);
  const names = (db.prepare(`SELECT name FROM people WHERE name LIKE 'auto-%' ORDER BY name`).all() as { name: string }[]).map((x) => x.name);
  assert.deepEqual(names, ["auto-contacted", "auto-recent"]);
  assert.deepEqual((db.prepare(`SELECT url FROM companies WHERE url LIKE 'auto-c-%'`).all() as { url: string }[]).map((x) => x.url), ["auto-c-new"]);
});

test("runAutoPurge: nothing removed means nothing logged", () => {
  const logs: string[] = [];
  const r = runAutoPurge(db, 30, (m) => logs.push(m));
  assert.deepEqual([r?.people, r?.companies, r?.batches], [0, 0, 0]);
  assert.deepEqual(logs, []);
});

test("runAutoPurge: a failing purge is swallowed, logged as failed, returns undefined", () => {
  const broken = { exec: () => { throw new Error("database is locked"); } } as unknown as typeof db;
  const logs: string[] = [];
  assert.equal(runAutoPurge(broken, 30, (m) => logs.push(m)), undefined);
  assert.deepEqual(logs, ["mcp-linkedin: auto-purge failed: database is locked"]);
});

test("purgeOld: a failing ROLLBACK does not mask the original error (runAutoPurge logs the original)", () => {
  const stub = {
    exec: (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed (B)");
    },
    prepare: () => { throw new Error("original failure (A)"); },
  } as unknown as typeof db;
  assert.throws(() => purgeOld(stub, 30, ["people"], false), { message: "original failure (A)" });
  const logs: string[] = [];
  assert.equal(runAutoPurge(stub, 30, (m) => logs.push(m)), undefined);
  assert.deepEqual(logs, ["mcp-linkedin: auto-purge failed: original failure (A)"]);
});
