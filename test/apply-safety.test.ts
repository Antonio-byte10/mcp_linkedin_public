// npx tsx test/apply-safety.test.ts — write-action safety (quota, batches, runner) on a temp SQLite file,
// plus the pure Easy Apply / connect rules. Never touches data/linkedin.db and never opens a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ItemResult } from "../src/guard/ledger.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-t1-"));
process.env.LINKEDIN_DB = path.join(tmp, "guard.db"); // belt and braces: nothing below imports store/db.ts

const L = await import("../src/guard/ledger.js");
const R = await import("../src/linkedin/writeRules.js");

let failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).stack ?? e}`);
  }
};

const limits = { apply_daily: 3, connect_daily: 2, connect_weekly: 100, message_daily: 5 };
let dbN = 0;
const opened: DatabaseSync[] = [];
function freshDb(): DatabaseSync {
  const d = new DatabaseSync(path.join(tmp, `t${++dbN}.db`));
  opened.push(d);
  d.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT, applied INTEGER DEFAULT 0, closed INTEGER DEFAULT 0);
    CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, target TEXT, status TEXT, detail TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE batches (id TEXT PRIMARY KEY, kind TEXT NOT NULL, items TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, used INTEGER DEFAULT 0);
  `);
  return d;
}
const statuses = (d: DatabaseSync) => (d.prepare(`SELECT target, status FROM actions ORDER BY id`).all() as { target: string; status: string }[]).map((r) => `${r.target}:${r.status}`);
const batchRow = (d: DatabaseSync, id: string) => {
  const r = d.prepare(`SELECT items, used FROM batches WHERE id=?`).get(id) as { items: string; used: number };
  return { ...L.parseBatch(r.items), used: r.used };
};
const claim = (d: DatabaseSync, batchId: string, ids: string[], left = 25) =>
  L.claimItems(d, { batchId, kind: "apply", ids, ttlMin: 30, quotaLeft: () => left, prepareTool: "apply_prepare" });

// ---------------- quota / reservations ----------------

await test("reserve: quota limit refuses the slot after the daily limit", () => {
  const d = freshDb();
  for (const t of ["1", "2", "3"]) assert.equal(L.reserveIn(d, limits, "apply", t).ok, true);
  assert.deepEqual(L.reserveIn(d, limits, "apply", "4"), { ok: false, reason: "quota" });
});

await test("reserve: refuses a target that is pending, done or unverified; failed frees it", () => {
  const d = freshDb();
  const r1 = L.reserveIn(d, limits, "connect", "u1");
  assert.ok(r1.ok);
  const dup = L.reserveIn(d, limits, "connect", "u1");
  assert.equal(dup.ok, false);
  assert.equal(!dup.ok && dup.reason, "duplicate");
  if (r1.ok) L.finishIn(d, r1.id, "failed", "x");
  const r2 = L.reserveIn(d, limits, "connect", "u1");
  assert.ok(r2.ok, "failed attempt does not block a retry");
  if (r2.ok) L.finishIn(d, r2.id, "unverified", "clicked");
  assert.equal(L.reserveIn(d, limits, "connect", "u1").ok, false, "unverified blocks a repeat");
  assert.equal(L.activeAction(d, "connect", "u1"), "unverified");
  assert.equal(L.countSince(d, "connect", "-1 day"), 1, "unverified counts against the quota, failed does not");
});

await test("reserve: messages are not deduplicated per target", () => {
  const d = freshDb();
  assert.ok(L.reserveIn(d, limits, "message", "p").ok);
  assert.ok(L.reserveIn(d, limits, "message", "p").ok);
});

await test("finishIn: onDone and the done flip commit together", () => {
  const d = freshDb();
  d.prepare(`INSERT INTO jobs (id) VALUES ('j1')`).run();
  const r = L.reserveIn(d, limits, "apply", "j1");
  assert.ok(r.ok);
  if (r.ok) L.finishIn(d, r.id, "done", "", () => d.prepare(`UPDATE jobs SET applied=1 WHERE id='j1'`).run());
  assert.equal((d.prepare(`SELECT applied FROM jobs WHERE id='j1'`).get() as { applied: number }).applied, 1);
  assert.deepEqual(statuses(d), ["j1:done"]);
});

await test("finishIn: a failing onDone rolls back (row stays pending, error surfaces)", () => {
  const d = freshDb();
  const r = L.reserveIn(d, limits, "apply", "j2");
  assert.ok(r.ok);
  assert.throws(() => r.ok && L.finishIn(d, r.id, "done", "", () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(statuses(d), ["j2:pending"]);
});

await test("tx: a failing ROLLBACK never masks the original error", () => {
  const d = freshDb();
  assert.throws(
    () =>
      L.tx(d, () => {
        d.exec("COMMIT"); // transaction already gone: the guarded ROLLBACK will fail
        throw new Error("original");
      }),
    /original/,
  );
  d.exec("BEGIN IMMEDIATE"); // the connection is usable again
  d.exec("ROLLBACK");
});

await test("sweepStale: old pending rows become unverified, recent ones stay pending", () => {
  const d = freshDb();
  d.prepare(`INSERT INTO actions (type,target,status,ts) VALUES ('apply','old','pending',datetime('now','-20 minutes'))`).run();
  d.prepare(`INSERT INTO actions (type,target,status) VALUES ('apply','new','pending')`).run();
  assert.equal(L.sweepStaleIn(d, 10), 1);
  assert.deepEqual(statuses(d), ["old:unverified", "new:pending"]);
});

// ---------------- batches ----------------

await test("claim: unknown / expired batch errors", () => {
  const d = freshDb();
  assert.throws(() => claim(d, "nope", ["1"]), /Unknown batch_id/);
  const id = L.newBatch(d, "apply", ["1"]);
  d.prepare(`UPDATE batches SET created_at=datetime('now','-31 minutes') WHERE id=?`).run(id);
  assert.throws(() => claim(d, id, ["1"]), /expired/);
  const c = L.newBatch(d, "connect", ["1"]);
  assert.throws(() => claim(d, c, ["1"]), /Unknown batch_id/, "an apply call cannot use a connect batch");
});

await test("claim: an id outside the batch or over quota throws and leaves the batch untouched", () => {
  const d = freshDb();
  const id = L.newBatch(d, "apply", ["111", "222"]);
  assert.throws(() => claim(d, id, ["111", "999"]), /Not in the batch: 999/);
  assert.throws(() => claim(d, id, ["111", "222"], 1), /Quota: only 1/);
  const b = batchRow(d, id);
  assert.deepEqual(b.state, { "111": "open", "222": "open" });
  assert.equal(b.used, 0);
  claim(d, id, ["111"]); // still claimable
  assert.equal(batchRow(d, id).state["111"], "claimed");
});

await test("claim: an id already claimed or finished cannot be claimed again (no replay)", () => {
  const d = freshDb();
  const id = L.newBatch(d, "apply", ["1", "2"]);
  claim(d, id, ["1"]);
  assert.throws(() => claim(d, id, ["1"]), /Already processed or in progress.*1 \(claimed\)/);
  L.settleItems(d, id, [{ id: "1", status: "done", success: true }]);
  assert.throws(() => claim(d, id, ["1"]), /1 \(done\)/);
});

await test("settle: unattempted / needs_answer / time_budget reopen; batch is used only when nothing is open", () => {
  const d = freshDb();
  const id = L.newBatch(d, "apply", ["a", "b", "c", "e"]);
  claim(d, id, ["a", "b", "c", "e"]);
  L.settleItems(d, id, [
    { id: "a", status: "done", success: true },
    { id: "b", status: "not_attempted", success: false, reason: "time_budget" },
    { id: "c", status: "needs_answer", success: false },
    { id: "e", status: "failed", success: false, reason: "time_budget" },
  ]);
  let b = batchRow(d, id);
  assert.deepEqual(b.state, { a: "done", b: "open", c: "open", e: "open" });
  assert.equal(b.used, 0);
  claim(d, id, ["b", "c", "e"]);
  L.settleItems(d, id, [
    { id: "b", status: "unverified", success: false },
    { id: "c", status: "skipped", success: false, reason: "already_applied" },
    { id: "e", status: "failed", success: false, reason: "no_next_button" },
  ]);
  b = batchRow(d, id);
  assert.deepEqual(b.state, { a: "done", b: "unverified", c: "skipped", e: "failed" });
  assert.equal(b.used, 1);
  assert.throws(() => claim(d, id, ["a"]), /already used up/);
});

await test("parseBatch: legacy rows (plain id array) are all open", () => {
  assert.deepEqual(L.parseBatch(`["1","2"]`), { ids: ["1", "2"], state: { "1": "open", "2": "open" } });
});

// ---------------- runner ----------------

const ok = (id: string): ItemResult => ({ id, status: "done", success: true });

await test("runItems: time budget is checked before every item, the first included (I6)", async () => {
  let calls = 0;
  const none = await L.runItems(["1", "2"], async (id) => (calls++, ok(id)), () => false);
  assert.equal(calls, 0, "no time at the start: nothing starts");
  assert.deepEqual(none.results.map((r) => `${r.id}:${r.status}:${r.reason ?? ""}`), ["1:not_attempted:time_budget", "2:not_attempted:time_budget"]);
  let budget = 1;
  const out = await L.runItems(["1", "2", "3"], async (id) => (calls++, ok(id)), () => budget-- > 0);
  assert.equal(calls, 1);
  assert.deepEqual(out.results.map((r) => `${r.id}:${r.status}:${r.reason ?? ""}`), ["1:done:", "2:not_attempted:time_budget", "3:not_attempted:time_budget"]);
});

await test("runItems: CHECKPOINT stops the loop and keeps earlier results", async () => {
  const out = await L.runItems(
    ["1", "2", "3"],
    async (id) => {
      if (id === "2") throw new Error("CHECKPOINT: LinkedIn is asking for verification\nmore");
      return ok(id);
    },
    () => true,
  );
  assert.equal(out.stopped, "CHECKPOINT: LinkedIn is asking for verification");
  assert.deepEqual(out.results.map((r) => `${r.id}:${r.status}`), ["1:done", "2:failed", "3:not_attempted"]);
});

await test("runItems: a non-account error fails one item and the loop continues; an item's stop stops it", async () => {
  const out = await L.runItems(
    ["1", "2", "3", "4"],
    async (id) => {
      if (id === "1") throw new Error("Timeout 5000ms exceeded");
      if (id === "2") return { id, status: "failed", success: false, reason: "weekly_limit", stop: "RATE_LIMITED: weekly limit" };
      return ok(id);
    },
    () => true,
  );
  assert.equal(out.stopped, "RATE_LIMITED: weekly limit");
  assert.deepEqual(out.results.map((r) => `${r.id}:${r.status}`), ["1:failed", "2:failed", "3:not_attempted", "4:not_attempted"]);
  assert.ok(!("stop" in out.results[1]), "stop is lifted to the run, not repeated per item");
});

await test("withReservation: a throwing act ends the reservation failed (never pending) and rethrows", async () => {
  const d = freshDb();
  await assert.rejects(L.withReservation(d, limits, "apply", "j", async () => { throw new Error("READ_BUDGET: x"); }), /READ_BUDGET/);
  assert.deepEqual(statuses(d), ["j:failed"]);
});

await test("withReservation: unverified holds the slot, needs_answer/skipped free it, quota/duplicate skip without acting", async () => {
  const d = freshDb();
  const u = await L.withReservation(d, limits, "apply", "u", async () => ({ status: "unverified" as const, reason: "unverified" }));
  assert.equal(u.status, "unverified");
  assert.equal(u.success, false);
  await L.withReservation(d, limits, "apply", "n", async () => ({ status: "needs_answer" as const, unanswered: ["Salary?"] }));
  await L.withReservation(d, limits, "apply", "s", async () => ({ status: "skipped" as const, reason: "job_closed" }));
  assert.deepEqual(statuses(d), ["u:unverified", "n:failed", "s:failed"]);
  let acted = false;
  const dup = await L.withReservation(d, limits, "apply", "u", async () => ((acted = true), { status: "done" as const }));
  assert.equal(dup.status, "skipped");
  assert.equal(dup.reason, "already_done_or_pending");
  assert.equal(acted, false);
});

await test("end to end: claim -> run (2nd item hits CHECKPOINT) -> settle; nothing pending, 3rd id still usable", async () => {
  const d = freshDb();
  for (const j of ["10", "20", "30"]) d.prepare(`INSERT INTO jobs (id) VALUES (?)`).run(j);
  const batch = L.newBatch(d, "apply", ["10", "20", "30"]);
  const ids = ["10", "20", "30"];
  claim(d, batch, ids, L.remainingIn(d, limits, "apply"));
  const out = await L.runItems(
    ids,
    (id) =>
      L.withReservation(
        d, limits, "apply", id,
        async () => {
          if (id === "20") throw new Error("CHECKPOINT: verify");
          return { status: "done" as const };
        },
        () => d.prepare(`UPDATE jobs SET applied=1 WHERE id=?`).run(id),
      ),
    () => true,
  );
  L.settleItems(d, batch, out.results);
  assert.equal(out.stopped, "CHECKPOINT: verify");
  assert.deepEqual(statuses(d), ["10:done", "20:failed"]);
  // M3: the CHECKPOINT was thrown before any submit, so item 20 is reopened (usable once the user resolves it).
  assert.deepEqual(batchRow(d, batch).state, { "10": "done", "20": "open", "30": "open" });
  assert.equal((d.prepare(`SELECT applied FROM jobs WHERE id='10'`).get() as { applied: number }).applied, 1);
  assert.equal((d.prepare(`SELECT applied FROM jobs WHERE id='20'`).get() as { applied: number }).applied, 0);
  claim(d, batch, ["20", "30"]); // the reopened and the unattempted ids are still claimable
  assert.deepEqual(L.summarize(out.results), { done: 1, failed: 1, not_attempted: 1 });
});

// ---------------- Easy Apply rules ----------------

await test("NEXT_RE / SUBMIT_RE: PT and EN labels, aria variants, never overlapping", () => {
  for (const s of ["Avançar", "Avaliar", "Revisar", "Continuar", "Next", "Review", "Continue", "Avançar para a próxima etapa", "Continue to next step", "Revise sua candidatura", "Review your application"]) {
    assert.ok(R.NEXT_RE.test(s), `next: ${s}`);
    assert.ok(!R.SUBMIT_RE.test(s), `not submit: ${s}`);
  }
  for (const s of ["Enviar candidatura", "Enviar", "Submit application", "Submit"]) {
    assert.ok(R.SUBMIT_RE.test(s), `submit: ${s}`);
    assert.ok(!R.NEXT_RE.test(s), `not next: ${s}`);
  }
  for (const s of ["Enviar mensagem", "Enviar com Premium", "Submit feedback", "Avançar mais tarde", "Salvar"]) {
    assert.ok(!R.SUBMIT_RE.test(s) && !R.NEXT_RE.test(s), `neither: ${s}`);
  }
});

await test("pickErrors: field errors count; a bare [role=alert] only with validation wording; hidden/empty ignored", () => {
  assert.deepEqual(
    R.pickErrors([
      { alert: false, text: " Este campo é obrigatório ", visible: true },
      { alert: true, text: "Candidatura salva", visible: true },
      { alert: true, text: "Please enter a valid answer", visible: true },
      { alert: false, text: "Insira um número", visible: false },
      { alert: false, text: "   ", visible: true },
      { alert: false, text: "Este campo é obrigatório", visible: true },
    ]),
    ["Este campo é obrigatório", "Please enter a valid answer"],
  );
});

await test("submitState: confirmation text / closed dialog = confirmed; errors = rejected; save prompt or still open = pending", () => {
  assert.equal(R.submitState({ dialogOpen: true, overlayText: "Sua candidatura foi enviada para a Acme", errors: [] }), "confirmed");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", errors: [], closedPolls: 2 }), "confirmed");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "Application sent", errors: [] }), "confirmed");
  assert.equal(R.submitState({ dialogOpen: true, overlayText: "", errors: ["Campo obrigatório"] }), "rejected");
  assert.equal(R.submitState({ dialogOpen: true, overlayText: "Candidate-se para Acme", errors: [] }), "pending");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "Salvar esta candidatura?", errors: [] }), "pending");
});

await test("isClosedJobText: PT/EN closed banners only", () => {
  assert.ok(R.isClosedJobText("Não aceita mais candidaturas"));
  assert.ok(R.isClosedJobText("No longer accepting applications"));
  assert.ok(!R.isClosedJobText("Candidatura simplificada · 30 candidatos"));
});

await test("dialog title: Easy Apply dialog yes, post-submit dialog no", () => {
  assert.ok(R.APPLY_DIALOG_TITLE_RE.test("Candidate-se para Acme"));
  assert.ok(R.APPLY_DIALOG_TITLE_RE.test("Apply to Acme"));
  assert.ok(!R.APPLY_DIALOG_TITLE_RE.test("Candidatura enviada"));
});

// ---------------- connect rules ----------------

await test("normaliseProfileId: only /in/<slug> URLs or bare slugs, normalised", () => {
  const n = R.normaliseProfileId;
  assert.equal(n("https://www.linkedin.com/in/Maria-Silva-123/?miniProfileUrn=x#y"), "https://www.linkedin.com/in/maria-silva-123/");
  assert.equal(n("linkedin.com/in/maria-silva-123"), "https://www.linkedin.com/in/maria-silva-123/");
  assert.equal(n("http://br.linkedin.com/in/maria-silva-123/"), "https://www.linkedin.com/in/maria-silva-123/");
  assert.equal(n("  maria-silva-123 "), "https://www.linkedin.com/in/maria-silva-123/");
  assert.equal(n("https://www.linkedin.com/in/jos%C3%A9-silva/"), "https://www.linkedin.com/in/jos%C3%A9-silva/");
  assert.equal(n("ACoAABcdEfGhIjKlMn"), "https://www.linkedin.com/in/ACoAABcdEfGhIjKlMn/", "opaque ids keep their case");
  assert.equal(n("https://www.linkedin.com/in/maria-silva-123/pt"), "https://www.linkedin.com/in/maria-silva-123/", "people_search locale suffix");
  assert.equal(n("https://www.linkedin.com/in/maria-silva-123/pt_BR/?trk=x"), "https://www.linkedin.com/in/maria-silva-123/");
  for (const bad of [
    "https://www.linkedin.com/m/logout/",
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/in/maria/detail/contact-info/",
    "https://www.linkedin.com/in/maria/details",
    "https://www.linkedin.com/in/maria/recent-activity/",
    "https://www.linkedin.com/in/maria/pt/extra",
    "https://evil.com/in/maria",
    "https://linkedin.com.evil.com/in/maria",
    "javascript:alert(1)",
    "https://user:pw@www.linkedin.com/in/maria",
    "https://www.linkedin.com/in/%E0%A4%A",
    "a",
    "maria silva",
  ]) assert.equal(n(bad), null, bad);
  assert.equal(R.profileSlug("https://www.linkedin.com/in/Maria-Silva/"), "maria-silva");
});

await test("classifyTopCard: pending / connected win; connect; more; follow-only; none", () => {
  const c = R.classifyTopCard;
  assert.equal(c(["Pendente", "Mais"], ""), "pending");
  assert.equal(c(["Pendente, clique para retirar o convite enviado a Maria"], ""), "pending");
  assert.equal(c(["Enviar mensagem", "Mais"], "Maria Silva · 1º\nHead de Dados"), "connected");
  assert.equal(c(["Conectar", "Mais"], "Maria Silva · 2º"), "connect");
  assert.equal(c(["Convidar Maria Silva para se conectar", "Mais"], ""), "connect");
  assert.equal(c(["Seguir", "Mais ações"], ""), "more");
  assert.equal(c(["Follow", "Message"], ""), "follow_only");
  assert.equal(c(["Enviar mensagem"], "1st Line Support Engineer"), "none", "a headline with '1st' is not a degree");
});

await test("classifyMenu: connect only when the menu offers it", () => {
  assert.equal(R.classifyMenu(["Enviar perfil", "Convidar Maria Silva para se conectar", "Denunciar"]), "connect");
  assert.equal(R.classifyMenu(["Remover conexão"]), "connected");
  assert.equal(R.classifyMenu(["Retirar convite"]), "pending");
  assert.equal(R.classifyMenu(["Enviar perfil", "Denunciar / bloquear"]), "none");
});

await test("names: invite aria-label parsing and tolerant matching", () => {
  assert.equal(R.inviteLabelName("Convidar Maria Silva para se conectar"), "Maria Silva");
  assert.equal(R.inviteLabelName("Invite José Souza to connect"), "José Souza");
  assert.equal(R.inviteLabelName("Conectar"), null);
  assert.ok(R.nameMatches("Maria  Silva, MBA 🚀", "Maria Silva"));
  assert.ok(R.nameMatches("José da Silva Souza", "Jose Souza"));
  assert.ok(!R.nameMatches("João Pereira", "Maria Silva"));
  assert.ok(!R.nameMatches("Maria Pereira", "Maria Silva"));
  assert.ok(R.isPlaceholderName("Membro do LinkedIn"));
});

await test("send/note/limit regexes are exact where it matters", () => {
  assert.ok(R.SEND_RE.test("Enviar") && R.SEND_RE.test("Send invitation") && R.SEND_RE.test("Enviar convite"));
  assert.ok(!R.SEND_RE.test("Enviar mensagem") && !R.SEND_RE.test("Enviar com Premium") && !R.SEND_RE.test("Send without a note"));
  assert.ok(R.SEND_NO_NOTE_RE.test("Enviar sem nota") && R.SEND_NO_NOTE_RE.test("Send without a note"));
  assert.ok(R.ADD_NOTE_RE.test("Adicionar nota") && R.ADD_NOTE_RE.test("Add a note"));
  assert.ok(R.WEEKLY_LIMIT_RE.test("Você atingiu o limite semanal de convites"));
  assert.ok(R.WEEKLY_LIMIT_RE.test("You've reached the weekly invitation limit"));
  assert.ok(R.NOTE_LIMIT_RE.test("Você usou todas as suas notas personalizadas deste mês"));
  assert.ok(R.CONNECT_RE.test("Conectar") && R.CONNECT_RE.test("Invite Ana Lima to connect") && !R.CONNECT_RE.test("Conectar-se com Premium"));
  assert.equal(R.NOTE_MAX, 300);
});

await test("regexes stay linear on long hostile input", () => {
  const long = "a ".repeat(50000) + "!";
  const t0 = Date.now();
  for (const re of [R.NEXT_RE, R.SUBMIT_RE, R.CONNECT_RE, R.NOTE_LIMIT_RE, R.WEEKLY_LIMIT_RE, R.EMAIL_REQUIRED_RE, R.APPLIED_RE]) re.test(long);
  R.inviteLabelName(`Convidar ${"x ".repeat(50000)}`);
  R.normaliseProfileId("x".repeat(100000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

// ---------------- final review (T6) ----------------

await test("I3 onJobPage: only the target job's view or currentJobId; other jobs, hosts and junk are a redirect", () => {
  assert.ok(R.onJobPage("https://www.linkedin.com/jobs/view/3000000001/", "3000000001"));
  assert.ok(R.onJobPage("https://www.linkedin.com/jobs/view/3000000001/?refId=x", "3000000001"));
  assert.ok(R.onJobPage("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3000000001", "3000000001"));
  assert.ok(!R.onJobPage("https://www.linkedin.com/jobs/view/3000000002/", "3000000001"));
  assert.ok(!R.onJobPage("https://www.linkedin.com/jobs/view/30000000010/", "3000000001"));
  assert.ok(!R.onJobPage("https://www.linkedin.com/checkpoint/challenge/", "3000000001"));
  assert.ok(!R.onJobPage("https://evil.example/jobs/view/3000000001/", "3000000001"));
  assert.ok(!R.onJobPage("not a url", "3000000001"));
});

await test("I3 dialogNamesCompany: the dialog title must name the job's company", () => {
  assert.ok(R.dialogNamesCompany("Candidate-se para Acme Ltda", "Acme Ltda"));
  assert.ok(R.dialogNamesCompany("Candidate-se à empresa Initech", "Initech"));
  assert.ok(R.dialogNamesCompany("Apply to Banco Umbrella", "Umbrella"));
  assert.ok(R.dialogNamesCompany("Candidatar-se para Hooli", "Hooli Alimentos"));
  assert.ok(!R.dialogNamesCompany("Candidate-se para Globex", "Acme Ltda"));
  assert.ok(!R.dialogNamesCompany("Candidate-se para Grupo Brasil", "Grupo Acme Brasil")); // only noise words shared
  assert.ok(!R.dialogNamesCompany("", "Acme"));
  assert.ok(R.dialogNamesCompany("Candidate-se para Qualquer", null)); // nothing cached to compare
});

await test("I4 submitState: a closed dialog confirms only after 2 consecutive polls; error toasts never confirm", () => {
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", errors: [], closedPolls: 1 }), "pending");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", errors: [], closedPolls: 2 }), "confirmed");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", toastText: "Não foi possível enviar sua candidatura. Tente novamente.", errors: [], closedPolls: 3 }), "error");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", toastText: "Something went wrong", errors: [], closedPolls: 5 }), "error");
  assert.equal(R.submitState({ dialogOpen: true, overlayText: "", toastText: "Try again later", errors: [] }), "error");
  assert.equal(R.submitState({ dialogOpen: false, overlayText: "", toastText: "Candidatura enviada", errors: [], closedPolls: 0 }), "confirmed");
  // a question inside the dialog that mentions "erro" is not a toast
  assert.equal(R.submitState({ dialogOpen: true, overlayText: "Qual a margem de erro aceitável?", errors: [] }), "pending");
});

await test("I3/M5/M6/I7 applyGate: redirect, closed, already applied, modality mismatch, else go", () => {
  const url = "https://www.linkedin.com/jobs/view/1/";
  assert.deepEqual(R.applyGate("https://www.linkedin.com/jobs/view/2/", "1", {}), { status: "failed", reason: "redirected" });
  assert.deepEqual(R.applyGate(url, "1", { closed: true }), { status: "skipped", reason: "job_closed", closed: true });
  assert.deepEqual(R.applyGate(url, "1", { applied: true }), { status: "skipped", reason: "already_applied", alreadyApplied: true });
  assert.deepEqual(R.applyGate(url, "1", { modality: "Presencial" }, (t) => t.modality !== "Presencial"), { status: "skipped", reason: "modality_mismatch" });
  assert.equal(R.applyGate(url, "1", { modality: "Remoto" }, (t) => t.modality !== "Presencial"), null);
});

await test("M2 withReservation: a settle that throws (onDone) keeps the real result", async () => {
  const d = freshDb();
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await L.withReservation(d, limits, "apply", "x", async () => ({ status: "done" as const }), () => {
      throw new Error("disk I/O error");
    });
    assert.equal(r.status, "done");
    assert.equal(r.success, true);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(statuses(d), ["x:pending"]); // rolled back: the stale sweep later marks it unverified, never freed
  d.prepare(`UPDATE actions SET ts=datetime('now','-1 hour')`).run();
  L.sweepStaleIn(d, 10);
  assert.deepEqual(statuses(d), ["x:unverified"]);
});

await test("M3 reopens: an account-level failure before the submit reopens; other failures do not", () => {
  assert.equal(L.reopens({ status: "failed", reason: "CHECKPOINT: verify" }), true);
  assert.equal(L.reopens({ status: "failed", reason: "LOGGED_OUT: x" }), true);
  assert.equal(L.reopens({ status: "failed", reason: "no_next_button" }), false);
  assert.equal(L.reopens({ status: "unverified", reason: "CHECKPOINT: after submit" }), false);
});

await test("M7 confirmUnverifiedApply: the tracker flips only unverified apply rows of that job to done", () => {
  const d = freshDb();
  d.prepare(`INSERT INTO actions (type,target,status) VALUES ('apply','7','unverified'),('apply','8','unverified'),('apply','7','failed'),('connect','7','unverified')`).run();
  assert.equal(L.confirmUnverifiedApply(d, "7"), 1);
  assert.deepEqual(d.prepare(`SELECT type, target, status FROM actions ORDER BY id`).all().map((r) => Object.values(r as object).join(":")), ["apply:7:done", "apply:8:unverified", "apply:7:failed", "connect:7:unverified"]);
});

await test("M13 sliding TTL: a done item restarts the batch clock; a failed one does not", () => {
  const d = freshDb();
  const id = L.newBatch(d, "apply", ["a", "b", "c"]);
  d.prepare(`UPDATE batches SET created_at=datetime('now','-25 minutes') WHERE id=?`).run(id);
  claim(d, id, ["a"]);
  L.settleItems(d, id, [{ id: "a", status: "failed", success: false, reason: "no_next_button" }]);
  const age = () => (d.prepare(`SELECT (julianday('now') - julianday(created_at)) * 1440 AS m FROM batches WHERE id=?`).get(id) as { m: number }).m;
  assert.ok(age() > 20);
  claim(d, id, ["b"]);
  L.settleItems(d, id, [{ id: "b", status: "done", success: true }]);
  assert.ok(age() < 1, "the clock restarted");
  d.prepare(`UPDATE batches SET created_at=datetime('now','-31 minutes') WHERE id=?`).run(id);
  assert.throws(() => claim(d, id, ["c"]), /expired/);
});

await test("M11 pollUntil: waits for a late value, gives up after the window", async () => {
  let n = 0;
  const fakeWait = async () => {};
  assert.equal(await R.pollUntil(async () => (++n >= 3 ? "modal" : null), 5000, 400, fakeWait), "modal");
  assert.equal(n, 3);
  const t0 = Date.now();
  assert.equal(await R.pollUntil(async () => null, 50, 10), null);
  assert.ok(Date.now() - t0 >= 45);
});

await test("M12 profileTargetCheck: vanity slug must match; opaque ids need the cached name; names must match", () => {
  const opaque = "ACoAABcdefghijklmnop";
  assert.equal(R.profileTargetCheck({ slug: "ana-lima", pageUrl: "https://www.linkedin.com/in/ana-lima/", h1: "Ana Lima" }), null);
  assert.match(R.profileTargetCheck({ slug: "ana-lima", pageUrl: "https://www.linkedin.com/in/other/", h1: "Ana Lima" })!, /redirected/);
  assert.match(R.profileTargetCheck({ slug: "ana-lima", pageUrl: "https://www.linkedin.com/feed/", h1: "" })!, /redirected/);
  assert.match(R.profileTargetCheck({ slug: opaque, pageUrl: "https://www.linkedin.com/in/ana-lima/", h1: "Ana Lima" })!, /opaque_id_without_known_name/);
  assert.equal(R.profileTargetCheck({ slug: opaque, pageUrl: "https://www.linkedin.com/in/ana-lima/", h1: "Ana Lima", expected: "Ana Lima" }), null);
  assert.match(R.profileTargetCheck({ slug: opaque, pageUrl: "https://www.linkedin.com/in/bruno-souza/", h1: "Bruno Souza", expected: "Ana Lima" })!, /name_mismatch/);
});

await test("M4 one Easy Apply dialog locator: mapper, apply and formfill share it ([role=dialog] + Candidatar-se)", () => {
  // DOM code cannot run here: check the sources use the shared locator and no old private copy is left.
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", f), "utf8");
  const mapper = src("mapper.ts");
  assert.match(mapper, /export function easyApplyDialog\(page: Page\) \{\s*return page\.locator\(EASY_APPLY_DIALOG_SEL\)\.filter\(\{ has: page\.locator\("h2", \{ hasText: APPLY_DIALOG_TITLE_RE \}\) \}\)/);
  assert.ok(!/Candidate-se\|Apply to\)/.test(mapper), "no old title regex left in mapper.ts");
  assert.match(mapper, /const easyLeft = await easyApplyDialog\(page\)\.count\(\)/);
  assert.match(mapper, /const close = easyApplyDialog\(page\)\.locator\(/);
  for (const f of ["apply.ts", "formfill.ts"]) {
    assert.match(src(f), /import \{[^}]*easyApplyDialog[^}]*\} from "\.\/mapper\.js"/, f);
    assert.ok(!/const easyApplyDialog =/.test(src(f)), `${f} has no private copy`);
  }
  assert.equal(R.EASY_APPLY_DIALOG_SEL, "dialog[open], [role=dialog]");
  assert.ok(R.APPLY_DIALOG_TITLE_RE.test("Candidatar-se para Acme"));
});

await test("I6 transcript: masked per-job file, attempts appended, never a path from a bad id", async () => {
  const { writeTranscript } = await import("../src/guard/transcript.js");
  const dir = path.join(tmp, "applications");
  const r1 = { status: "needs_answer", reason: "needs_answer", unanswered: ["CPF — sensitive_needs_confirmation:profile.cpf"], answers: [{ step: 0, label: "Phone*", kind: "tel", status: "kept", source: "profile.phone.national", value: "***" }] };
  const f = writeTranscript(dir, "3000000001", r1)!;
  writeTranscript(dir, "3000000001", { status: "done" });
  const saved = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(saved.job_id, "3000000001");
  assert.deepEqual(saved.attempts.map((x: { status: string }) => x.status), ["needs_answer", "done"]);
  assert.equal(saved.attempts[0].answers[0].value, "***");
  assert.equal(writeTranscript(dir, "../../etc/passwd", r1), null);
  assert.ok(!fs.existsSync(path.join(dir, "3000000001.json.tmp")));
});

for (const d of opened) d.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Windows may still hold the files for a moment; they are in the OS temp dir
}
if (failed) {
  console.log(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("all apply-safety tests passed");
