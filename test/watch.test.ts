// Saved searches store + "new since" diff on a temp SQLite file (no browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-t6-"));
process.env.LINKEDIN_DB = path.join(tmp, "data.db");

const { db } = await import("../src/store/db.js");
const { cleanName, deleteSearch, listSearches, markRun, onlyNew, saveSearch, MAX_SAVED_SEARCHES } = await import("../src/store/watch.js");

test("onlyNew keeps ids absent from the pre-search snapshot", () => {
  const jobs = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(onlyNew(jobs, new Set(["2"])), [{ id: "1" }, { id: "3" }]);
  assert.deepEqual(onlyNew(jobs, new Set(["1", "2", "3"])), []);
  assert.deepEqual(onlyNew([], new Set()), []);
});

test("names: trimmed, 1..60, no control characters", () => {
  assert.equal(cleanName("  data  "), "data");
  assert.throws(() => cleanName("   "));
  assert.throws(() => cleanName("x".repeat(61)));
  assert.throws(() => cleanName("a\nb"));
  assert.throws(() => cleanName("a\u0000b"));
});

test("save upserts, list parses params, markRun, delete", () => {
  saveSearch(db, " dados ", { keywords: "data engineer" });
  saveSearch(db, "dados", { keywords: "analytics", remote: "remote" });
  const l = listSearches(db);
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].params, { keywords: "analytics", remote: "remote" });
  assert.equal(l[0].last_run_at, null);
  markRun(db, "dados");
  assert.ok(listSearches(db)[0].last_run_at);
  assert.equal(deleteSearch(db, "dados"), true);
  assert.equal(deleteSearch(db, "dados"), false);
});

test("cap: new names beyond the limit rejected, updates still allowed", () => {
  for (let i = 0; i < MAX_SAVED_SEARCHES; i++) saveSearch(db, `s${i}`, { keywords: "k" });
  assert.throws(() => saveSearch(db, "extra", { keywords: "k" }), /At most 20/);
  saveSearch(db, "s0", { keywords: "changed" });
  assert.equal(listSearches(db).length, MAX_SAVED_SEARCHES);
});

const { runWatch, PER_SEARCH_MS } = await import("../src/store/watch.js");
const { config } = await import("../src/config.js");
const S = (name: string) => ({ name, params: {}, created_at: "", last_run_at: null });
const deps = (over: Record<string, unknown> = {}) => {
  const marked: string[] = [];
  return { marked, d: { search: async (s: { name: string }) => s.name, hasTime: () => true, isAccountError: (m: string) => /^CHECKPOINT/.test(m), markRun: (n: string) => void marked.push(n), ...over } };
};

test("per-search need fits the default call budget", () => {
  assert.ok(PER_SEARCH_MS < config.callBudgetMs);
});

test("runWatch: first search runs even without time; the rest are left", async () => {
  const { d, marked } = deps({ hasTime: () => false });
  const r = await runWatch([S("a"), S("b"), S("c")], d);
  assert.deepEqual(r.results.map((x) => x.name), ["a"]);
  assert.deepEqual(r.left, ["b", "c"]);
  assert.deepEqual(marked, ["a"]);
});

test("runWatch: account error stops, name stays in left, not marked", async () => {
  const { d, marked } = deps({ search: async (s: { name: string }) => { if (s.name === "b") throw new Error("CHECKPOINT: x"); return 1; } });
  const r = await runWatch([S("a"), S("b"), S("c")], d);
  assert.match(r.stopped ?? "", /^CHECKPOINT/);
  assert.deepEqual(r.left, ["b", "c"]);
  assert.deepEqual(marked, ["a"]);
});

test("runWatch: other error is recorded and the loop continues", async () => {
  const { d, marked } = deps({ search: async (s: { name: string }) => { if (s.name === "a") throw new Error("boom"); return 1; } });
  const r = await runWatch([S("a"), S("b")], d);
  assert.deepEqual(r.errors, [{ name: "a", error: "boom" }]);
  assert.deepEqual(r.results.map((x) => x.name), ["b"]);
  assert.deepEqual(r.left, []);
  assert.deepEqual(marked, ["b"]);
});
