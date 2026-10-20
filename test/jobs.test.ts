import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Temp DB before anything imports the store (db.ts opens config.dbPath at import time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t2-jobs-"));
const dbFile = path.join(tmp, "test.db");
process.env.LINKEDIN_DB = dbFile;

let n = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const { config, num, bool } = await import("../src/config.js");
const store = await import("../src/store/db.js");
const jobs = await import("../src/linkedin/jobs.js");
const tracker = await import("../src/linkedin/tracker.js");
const session = await import("../src/browser/session.js");
const { db } = store;

// ---- config ----
test("LINKEDIN_DB overrides the db path", () => {
  assert.equal(config.dbPath, path.resolve(dbFile));
  assert.ok(fs.existsSync(dbFile));
});
test("num rejects empty / blank / NaN / negative / Infinity (fallback)", () => {
  for (const bad of [undefined, "", "   ", "abc", "NaN", "-5", "Infinity"]) assert.equal(num(bad, 42), 42, String(bad));
  assert.equal(num("0", 42), 0);
  assert.equal(num("1500", 42), 1500);
});
test("bool parses LINKEDIN_HEADLESS style values", () => {
  assert.equal(bool(undefined, true), true);
  assert.equal(bool("", true), true);
  for (const f of ["0", "false", "FALSE", "no", "off"]) assert.equal(bool(f, true), false, f);
  for (const t of ["1", "true", "yes", "on"]) assert.equal(bool(t, false), true, t);
  assert.equal(bool("maybe", true), true);
});
test("callBudgetMs is never 0", () => assert.ok(config.callBudgetMs > 0));

// ---- URLs ----
test("buildSearchUrl filters and start", () => {
  const u = new URL(jobs.buildSearchUrl({ keywords: "data analyst", location: "São Paulo", remote: "remote", easy_apply: true, posted_within: "week", experience: ["entry", "senior"] }, 50));
  assert.equal(u.searchParams.get("keywords"), "data analyst");
  assert.equal(u.searchParams.get("f_WT"), "2");
  assert.equal(u.searchParams.get("f_AL"), "true");
  assert.equal(u.searchParams.get("f_TPR"), "r604800");
  assert.equal(u.searchParams.get("f_E"), "2,4");
  assert.equal(u.searchParams.get("start"), "50");
  assert.equal(new URL(jobs.buildSearchUrl({ keywords: "x" })).searchParams.has("start"), false);
});
test("session url classification: only /checkpoint is a verification wall", () => {
  assert.ok(session.isVerificationUrl("https://www.linkedin.com/checkpoint/challenge/abc"));
  assert.ok(!session.isVerificationUrl("https://www.linkedin.com/login"));
  assert.ok(session.isLoginUrl("https://www.linkedin.com/authwall?trk=x"));
  assert.ok(session.isLoginUrl("https://www.linkedin.com/uas/login"));
  assert.ok(session.isCheckpointUrl("https://www.linkedin.com/login"));
  assert.ok(!session.isCheckpointUrl("https://www.linkedin.com/jobs/search/?keywords=challenge"));
  assert.ok(!session.isCheckpointUrl("https://example.com/login"));
});
test("gotoSafe maps a Playwright timeout to NAV_TIMEOUT and passes a 20 s timeout", async () => {
  let seen: unknown;
  const page = {
    goto: async (_u: string, o: unknown) => {
      seen = o;
      const e = new Error("page.goto: Timeout 20000ms exceeded.");
      e.name = "TimeoutError";
      throw e;
    },
  };
  await assert.rejects(() => session.gotoSafe(page as never, "https://www.linkedin.com/feed/"), /^Error: NAV_TIMEOUT: \/feed\//);
  assert.equal((seen as { timeout: number }).timeout, 20000);
});

// ---- paging (finding 2) ----
test("sliceSearchResults: offset continues where the previous call stopped", () => {
  const cards = Array.from({ length: 50 }, (_, i) => i); // two pages from start=0
  let r = jobs.sliceSearchResults(cards, 0, 30, false, 2);
  assert.equal(r.jobs.length, 30);
  assert.equal(r.next_start, 30);
  // next call: offset 30 -> reads from page start 25, drops the first 5
  const second = Array.from({ length: 50 }, (_, i) => 25 + i);
  r = jobs.sliceSearchResults(second, 30, 25, false, 2);
  assert.equal(r.jobs[0], 30);
  assert.equal(r.jobs.length, 25);
  assert.equal(r.next_start, 55);
});
test("sliceSearchResults: exhausted -> next_start null; time cut -> page after the last read", () => {
  assert.equal(jobs.sliceSearchResults([1, 2, 3], 0, 25, true, 1).next_start, null);
  assert.equal(jobs.sliceSearchResults(Array.from({ length: 25 }, (_, i) => i), 0, 75, false, 1).next_start, 25);
  assert.equal(jobs.sliceSearchResults(Array.from({ length: 25 }, (_, i) => i), 50, 75, false, 1).next_start, 75);
});

// ---- posted / applied regexes (finding 8) ----
test("POSTED_RE handles Republicado / Anunciada variants", () => {
  for (const s of ["há 2 dias", "Republicado há 2 dias", "Anunciada há 3 d", "há 18 horas", "2 days ago", "Reposted 1 week ago"]) assert.ok(jobs.POSTED_RE.test(s), s);
  for (const s of ["Remoto", "São Paulo", "59 candidaturas", "Hábil"]) assert.ok(!jobs.POSTED_RE.test(s), s);
});
test("APPLIED_LINE: PT/EN status lines, not titles", () => {
  for (const s of ["Candidatou-se há 2 d", "Applied 3d ago", "Applied", "Candidatura enviada", "Candidatou-se em 10 de out."]) assert.ok(jobs.APPLIED_LINE.test(s), s);
  for (const s of ["Applied Materials", "Applied Scientist"]) assert.ok(!jobs.APPLIED_LINE.test(s), s);
});
test("postedToIso converts relative text to an absolute date", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(store.postedToIso("Republicado há 2 dias", now), "2026-10-12T12:00:00.000Z");
  assert.equal(store.postedToIso("Anunciada há 3 d", now), "2026-10-11T12:00:00.000Z");
  assert.equal(store.postedToIso("há 18 horas", now), "2026-10-13T18:00:00.000Z");
  assert.equal(store.postedToIso("2 days ago", now), "2026-10-12T12:00:00.000Z");
  assert.equal(store.postedToIso("há 1 semana", now), "2026-10-07T12:00:00.000Z");
  assert.equal(store.postedToIso("Remoto", now), "");
  assert.equal(store.postedToIso(null, now), "");
});

// ---- job page parsing (findings 5, 8, 9) ----
const page = (extra: string[] = []) => [
  "Acme Ltda",
  ...extra,
  "Analista de Dados",
  "São Paulo, SP · Republicado há 2 dias · 59 candidaturas",
  "Remoto",
  "Tempo integral",
  "Candidatura simplificada",
  "Sobre a vaga",
  "Descrição ...",
  "Requisitos adicionados pelo anunciante da vaga",
  "• SQL",
  "• Python",
  "Sobre a empresa",
];
test("parseJobLines: standard layout", () => {
  const p = jobs.parseJobLines(page());
  assert.equal(p.company, "Acme Ltda");
  assert.equal(p.title, "Analista de Dados");
  assert.equal(p.location, "São Paulo, SP");
  assert.equal(p.posted, "Republicado há 2 dias");
  assert.equal(p.applicants, "59 candidaturas");
  assert.equal(p.modality, "Remoto");
  assert.equal(p.employment_type, "Tempo integral");
  assert.deepEqual(p.requirements, ["SQL", "Python"]);
  assert.ok(p.hasMeta && !p.closed && !p.applied);
});
test("M5/M6 apply gate on the job page: closed/applied only from the top card, never from the description", async () => {
  const R = await import("../src/linkedin/writeRules.js");
  const url = "https://www.linkedin.com/jobs/view/123/";
  const withDesc = (desc: string, top: string[] = []) => {
    const p = page(top);
    p.splice(p.indexOf("Sobre a vaga") + 1, 0, desc);
    return jobs.parseJobLines(p);
  };
  // A description or a similar-jobs card below "Sobre a vaga" that says "closed" / "Candidatou-se" changes nothing.
  assert.equal(R.applyGate(url, "123", withDesc("Esta vaga não aceita mais candidaturas de estagiários.")), null);
  assert.equal(R.applyGate(url, "123", withDesc("Candidatou-se há 2 dias")), null);
  // The same words in the job's own top card do.
  const closed = jobs.parseJobLines(["Acme Ltda", "Analista", "São Paulo · há 3 d · 10 candidaturas", "Não aceita mais candidaturas", "Sobre a vaga", "x"]);
  assert.deepEqual(R.applyGate(url, "123", closed), { status: "skipped", reason: "job_closed", closed: true });
  const applied = jobs.parseJobLines(["Acme Ltda", "Analista", "São Paulo · há 3 d · 10 candidaturas", "Candidatou-se há 2 dias", "Sobre a vaga", "x"]);
  assert.deepEqual(R.applyGate(url, "123", applied), { status: "skipped", reason: "already_applied", alreadyApplied: true });
  // I7: the modality pill reaches the preference check.
  assert.equal(jobs.parseJobLines(page()).modality, "Remoto");
  assert.deepEqual(R.applyGate(url, "123", jobs.parseJobLines(page()), (t) => t.modality !== "Remoto"), { status: "skipped", reason: "modality_mismatch" });
});
test("parseJobLines: a Promovida badge line does not shift company/title", () => {
  const lines = ["Acme Ltda", "Analista de Dados", "Promovida", "São Paulo · há 3 d · 10 candidaturas"];
  const p = jobs.parseJobLines(lines);
  assert.equal(p.title, "Analista de Dados");
  assert.equal(p.company, "Acme Ltda");
});
test("parseJobLines: anchored company/title win; unmatched anchors are ignored", () => {
  const lines = ["Logo", "Acme Ltda", "Analista de Dados", "SP · há 2 dias · 5 candidaturas"];
  let p = jobs.parseJobLines(lines, { company: "Acme Ltda", title: "Analista de Dados" });
  assert.equal(p.company, "Acme Ltda");
  p = jobs.parseJobLines(lines, { company: "Not in page" });
  assert.equal(p.company, "Acme Ltda"); // positional fallback
});
test("parseJobLines: 'Promovida · Candidatura simplificada' is not mistaken for the meta line", () => {
  const p = jobs.parseJobLines(["Acme", "Dev", "Promovida · Candidatura simplificada", "SP · há 2 dias · 5 candidaturas"]);
  assert.equal(p.posted, "há 2 dias");
  assert.equal(p.title, "Dev");
});
test("parseJobLines: blank page has no meta; closed and applied detected only in the top card", () => {
  assert.equal(jobs.parseJobLines([]).hasMeta, false);
  const p = jobs.parseJobLines(["Acme", "Dev", "SP · há 2 dias · 5 candidaturas", "Não aceita mais candidaturas", "Candidatou-se há 2 d", "Sobre a vaga", "Applied", "no longer accepting"]);
  assert.ok(p.closed && p.applied);
  const q = jobs.parseJobLines(["Acme", "Dev", "SP · há 2 dias · 5 candidaturas", "Sobre a vaga", "Não aceita mais candidaturas"]);
  assert.ok(!q.closed);
});

// ---- tracker (findings 3, 6) ----
test("parseTrackerCard keeps both bracket lines and closed is seen", () => {
  const c = tracker.parseTrackerCard("https://www.linkedin.com/jobs/view/123/", [
    "Analista", "Acme · São Paulo (Remoto)", "Candidatou-se há 2 d", "(Anunciada há 3 d)", "(Não aceita mais candidaturas)",
  ]);
  assert.equal(c.id, "123");
  assert.equal(c.company, "Acme");
  assert.equal(c.when, "Candidatou-se há 2 d");
  assert.equal(c.status, "Anunciada há 3 d; Não aceita mais candidaturas");
  assert.ok(tracker.CLOSED_STATUS.test(c.status));
  const single = tracker.parseTrackerCard("/jobs/view/9/", ["T", "C · L", "(Anunciada há 3 d)"]);
  assert.equal(single.status, "Anunciada há 3 d");
  assert.ok(!tracker.CLOSED_STATUS.test(single.status));
});
test("parseTrackerCard: '•' separator, and a card without a company never turns the place into the company", () => {
  const p = (l: string) => tracker.parseTrackerCard("/jobs/view/9/", ["Data Analyst", l]);
  assert.deepEqual([p("Brasil • (Remoto)").company, p("Brasil • (Remoto)").location], ["", "Brasil (Remoto)"]); // live card
  assert.deepEqual([p("São Paulo, Brasil (Híbrido)").company, p("São Paulo, Brasil (Híbrido)").location], ["", "São Paulo, Brasil (Híbrido)"]);
  assert.deepEqual([p("Acme • Brasil (Remoto)").company, p("Acme • Brasil (Remoto)").location], ["Acme", "Brasil (Remoto)"]);
  assert.deepEqual([p("Initech · Brasil (Remoto)").company, p("Initech · Brasil (Remoto)").location], ["Initech", "Brasil (Remoto)"]);
  assert.deepEqual([p("Empresa Confidencial").company, p("Empresa Confidencial").location], ["Empresa Confidencial", ""]);
});
test("waitForAdvance: true when the first card changes, false when it never does", async () => {
  const noSleep = async () => {};
  let calls = 0;
  assert.equal(await tracker.waitForAdvance(async () => (++calls > 3 ? "b" : "a"), "a", 10, noSleep), true);
  assert.equal(await tracker.waitForAdvance(async () => "a", "a", 10, noSleep), false);
  assert.equal(await tracker.waitForAdvance(async () => undefined, "a", 5, noSleep), false);
});

// ---- db (findings 5, 10, 11, 12) ----
test("upsertJob: blanks never overwrite; easy_apply null stays unknown; posted_at set once", () => {
  store.upsertJob({ id: "1", title: "Dev", company: "Acme", easy_apply: 1, posted: "há 2 dias", description: "good" });
  store.upsertJob({ id: "1", title: "", company: null, easy_apply: null, posted: "", description: "" });
  let r = store.getJob("1")!;
  assert.equal(r.title, "Dev");
  assert.equal(r.company, "Acme");
  assert.equal(r.easy_apply, 1);
  assert.equal(r.description, "good");
  const at = r.posted_at;
  assert.ok(at && !Number.isNaN(Date.parse(at)));
  store.upsertJob({ id: "1", posted: "há 5 dias" });
  assert.equal(store.getJob("1")!.posted_at, at); // first sighting wins
  store.upsertJob({ id: "2", title: "X", easy_apply: null });
  assert.equal(store.getJob("2")!.easy_apply, null);
  store.upsertJob({ id: "2", easy_apply: 0 });
  assert.equal(store.getJob("2")!.easy_apply, 0);
  store.upsertJob({ id: "2", easy_apply: 1 });
  assert.equal(store.getJob("2")!.easy_apply, 1);
  r = store.getJob("1")!;
  assert.equal(r.enriched_at, null);
});
test("saveDetail never replaces stored requirements with [] and a failure leaves enriched_at NULL", () => {
  store.upsertJob({ id: "3", title: "Dev" });
  store.saveDetail("3", { modality: "Remoto", employment_type: "", applicants: "", requirements: ["SQL"], company_url: "" });
  assert.equal(store.getJob("3")!.requirements, '["SQL"]');
  store.saveDetail("3", { modality: "", employment_type: "", applicants: "", requirements: [], company_url: "" });
  const r = store.getJob("3")!;
  assert.equal(r.requirements, '["SQL"]');
  assert.equal(r.modality, "Remoto");
  assert.ok(r.enriched_at);
  store.upsertJob({ id: "4", title: "Blank" });
  store.recordEnrichFailure("4");
  assert.equal(store.getJob("4")!.enriched_at, null);
});
test("closed resets only through setClosed (job page); applied only rises", () => {
  store.upsertJob({ id: "5", closed: 1, applied: 1 });
  store.upsertJob({ id: "5", closed: 0, applied: 0 });
  assert.equal(store.getJob("5")!.closed, 1);
  assert.equal(store.getJob("5")!.applied, 1);
  store.setClosed("5", false);
  assert.equal(store.getJob("5")!.closed, 0);
});
test("enrich retry cap: a job failing MAX_ENRICH_ATTEMPTS times leaves the auto-pick", () => {
  store.upsertJob({ id: "6", title: "Dev" });
  assert.ok(store.listEnrichCandidates().some((j) => j.id === "6"));
  for (let i = 0; i < store.MAX_ENRICH_ATTEMPTS; i++) store.recordEnrichFailure("6");
  assert.ok(!store.listEnrichCandidates().some((j) => j.id === "6"));
  assert.equal(store.getJob("6")!.enrich_attempts, store.MAX_ENRICH_ATTEMPTS);
  assert.ok(store.getJob("6")!.enrich_failed_at);
});
test("claimRead is atomic across two connections and respects the limit", () => {
  const other = new DatabaseSync(dbFile, { timeout: 5000 });
  // A second connection plays "the other MCP server": interleave updates on the same counter.
  const claimOther = () =>
    !!other
      .prepare(
        `INSERT INTO kv (k,v) VALUES ('reads:D', json_object('job', 1))
         ON CONFLICT(k) DO UPDATE SET v=json_set(v, '$.job', COALESCE(json_extract(v,'$.job'),0)+1) WHERE COALESCE(json_extract(v,'$.job'),0) < 5
         RETURNING v`,
      )
      .get();
  let granted = 0;
  for (let i = 0; i < 4; i++) {
    if (store.claimRead("D", "job", 5)) granted++;
    if (claimOther()) granted++;
  }
  assert.equal(granted, 5);
  assert.equal(store.readCounts("D").job, 5);
  assert.equal(store.claimRead("D", "job", 5), false);
  other.close();
});
test("refundRead gives a unit back, never below 0; corrupted kv value resets instead of throwing", () => {
  assert.equal(store.claimRead("R", "search", 2), true);
  store.refundRead("R", "search");
  assert.equal(store.readCounts("R").search, 0);
  store.refundRead("R", "search");
  assert.equal(store.readCounts("R").search, 0);
  store.kvSet("reads:C", "{not json");
  assert.deepEqual(store.readCounts("C"), {});
  assert.equal(store.claimRead("C", "job", 3), true);
  assert.equal(store.readCounts("C").job, 1);
});
test("claimRead tracks kinds independently", () => {
  assert.equal(store.claimRead("K", "job", 1), true);
  assert.equal(store.claimRead("K", "job", 1), false);
  assert.equal(store.claimRead("K", "search", 1), true);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    n++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).stack?.split("\n").slice(0, 4).join("\n  ")}`);
  }
}
db.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
console.log(`${n}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
