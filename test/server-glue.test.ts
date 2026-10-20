import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Temp DB before anything imports the store (db.ts opens config.dbPath at import time). Never data/linkedin.db.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t5-glue-"));
process.env.LINKEDIN_DB = path.join(tmp, "test.db");

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("the MCP server reports the package.json version", () => {
  const root = path.join(import.meta.dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const src = fs.readFileSync(path.join(root, "src", "server.ts"), "utf8");
  assert.ok(src.includes(`{ name: "mcp-linkedin", version: "${pkg.version}" }`), `server.ts version != package.json ${pkg.version}`);
});

const pure = await import("../src/linkedin/peoplePure.js");
const { pairs } = await import("../src/linkedin/dom.js");
const { likeContains, escapeLike } = await import("../src/export/xlsx.js");
const { sliceSearchResults } = await import("../src/linkedin/jobs.js");
const store = await import("../src/store/db.js");
const { savePeople } = await import("../src/linkedin/people.js");
const { saveCompanyAbout, resolveCompany, parseCompanyCard } = await import("../src/linkedin/companies.js");
const { db } = store;

// ---- splitCurrent ----
test("splitCurrent: simple role na company", () => {
  assert.deepEqual(pure.splitCurrent("Head de Dados na Hooli"), { role: "Head de Dados", company: "Hooli" });
});
test("splitCurrent: trailing 'em <place>' is not the company", () => {
  assert.deepEqual(pure.splitCurrent("Engenheiro de Dados na Acme em São Paulo"), { role: "Engenheiro de Dados", company: "Acme" });
});
test("splitCurrent: company containing ' na ' keeps its name (first separator wins)", () => {
  assert.deepEqual(pure.splitCurrent("Head na Casa na Praia"), { role: "Head", company: "Casa na Praia" });
});
test("splitCurrent: a tail that is not a company is skipped, never garbled", () => {
  // live: " na " inside the role text produced "área de dados, Salesforce, SAP..." as the company
  assert.deepEqual(pure.splitCurrent("Autônomo - Consultor na área de dados, Salesforce e SAP"), { role: "Autônomo - Consultor na área de dados, Salesforce e SAP", company: "" });
  assert.deepEqual(pure.splitCurrent("Professor no ensino médio na Escola Alfa"), { role: "Professor no ensino médio", company: "Escola Alfa" });
  assert.deepEqual(pure.splitCurrent("Analista na Acme, Inc"), { role: "Analista", company: "Acme" });
  assert.deepEqual(pure.splitCurrent("Especialista na Python"), { role: "Especialista na Python", company: "" });
  // camelCase brands are companies
  assert.deepEqual(pure.splitCurrent("Analista de Dados no iFood"), { role: "Analista de Dados", company: "iFood" });
});
test("splitCurrent: at / @ and bare subject with 'em'", () => {
  assert.deepEqual(pure.splitCurrent("Tech Recruiter at Globex"), { role: "Tech Recruiter", company: "Globex" });
  assert.deepEqual(pure.splitCurrent("Dev @ Initech"), { role: "Dev", company: "Initech" });
  assert.deepEqual(pure.splitCurrent("Analista em Dados"), { role: "Analista em Dados", company: "" });
  assert.deepEqual(pure.splitCurrent(""), { role: "", company: "" });
});

test("parsePersonCard: badges and Seguindo are not headline/location", () => {
  const p = pure.parsePersonCard("https://www.linkedin.com/in/x", ["Ana Silva • 2º", "Premium", "Technical Recruiter na Acme", "São Paulo, Brasil", "Seguindo", "Atual: Recruiter na Acme em Campinas"]);
  assert.equal(p.name, "Ana Silva");
  assert.equal(p.degree, "2º");
  assert.equal(p.headline, "Technical Recruiter na Acme");
  assert.equal(p.location, "São Paulo, Brasil");
  assert.equal(p.company, "Acme");
  assert.equal(p.action, "Seguindo");
});

// ---- company id from URN / links ----
test("extractCompanyId: urn, f_C, encoded currentCompany, numeric slug", () => {
  assert.equal(pure.extractCompanyId(["urn:li:fsd_company:1234567"]), "1234567");
  assert.equal(pure.extractCompanyId(["/jobs/search/?keywords=a&f_C=98765&x=1"]), "98765");
  assert.equal(pure.extractCompanyId(["/search/results/people/?currentCompany=%5B%2255555%22%5D"]), "55555");
  assert.equal(pure.extractCompanyId(["https://www.linkedin.com/company/424242/"]), "424242");
  assert.equal(pure.extractCompanyId(["https://www.linkedin.com/company/acme/", ""]), "");
  assert.equal(pure.extractCompanyId(["/company/x?f_C=%zz", "urn:li:company:777"]), "777"); // bad encoding does not throw
});
test("extractCompanyId: first candidate in order wins", () => {
  assert.equal(pure.extractCompanyId(["/jobs/search/?f_C=111", "urn:li:fsd_company:222"]), "111");
});
test("parseCompanyCard carries company_id from card hrefs", () => {
  const c = parseCompanyCard("https://www.linkedin.com/company/acme", ["Acme", "Software", "Brasil"], ["https://www.linkedin.com/company/acme"]);
  assert.equal(c.company_id, "");
  const d = parseCompanyCard("https://www.linkedin.com/company/123456", ["Acme"], ["https://www.linkedin.com/company/123456"]);
  assert.equal(d.company_id, "123456");
});

test("pickCompany: exact, prefix, never a guess", () => {
  const cards = [{ name: "Acme Consulting" }, { name: "Acme Brasil Ltda" }, { name: "Globex S.A." }];
  assert.equal(pure.pickCompany("globex", cards)?.name, "Globex S.A.");
  assert.equal(pure.pickCompany("Acme", cards)?.name, "Acme Consulting");
  assert.equal(pure.pickCompany("Initech", cards), undefined);
  assert.equal(pure.pickCompany("Acm", cards), undefined);
  assert.equal(pure.pickCompany("  ", cards), undefined);
});

// ---- pairs() ----
test("pairs: a label without a value never takes the next label as value", () => {
  const labels = ["Telefone", "Setor", "Site"];
  assert.deepEqual(pairs(["Telefone", "Setor", "Tecnologia", "Site", "acme.com"], labels), { Setor: "Tecnologia", Site: "acme.com" });
});

// ---- like escape wiring ----
test("likeContains escapes wildcards and works with ESCAPE in SQL", () => {
  assert.equal(escapeLike("100%_a\\b"), "100\\%\\_a\\\\b");
  db.prepare(`DELETE FROM people`).run();
  const ins = db.prepare(`INSERT INTO people (url,name,headline) VALUES (?,?,?)`);
  ins.run("u1", "A", "grew 100% yoy");
  ins.run("u2", "B", "grew 1000 yoy");
  ins.run("u3", "C", "a_b");
  ins.run("u4", "D", "axb");
  const q = (kw: string) => (db.prepare(`SELECT url FROM people WHERE headline LIKE ? ESCAPE '\\'`).all(likeContains(kw)) as { url: string }[]).map((r) => r.url);
  assert.deepEqual(q("100%"), ["u1"]);
  assert.deepEqual(q("a_b"), ["u3"]);
});

// ---- cache is not clobbered by empty values / junk ----
test("savePeople keeps previously parsed fields when a later card has them empty", () => {
  const base = { url: "https://www.linkedin.com/in/ana", name: "Ana", degree: "2º", headline: "Recruiter", location: "SP", current: "", role: "Recruiter", company: "Acme", mutual: "", action: "" };
  savePeople([base]);
  savePeople([{ ...base, headline: "", location: "", role: "", company: "", degree: "" }]);
  // stored under the normalised profile URL (the cache key never carries a locale suffix or query)
  const r = db.prepare(`SELECT * FROM people WHERE url=?`).get("https://www.linkedin.com/in/ana/") as Record<string, string>;
  assert.equal(r.company, "Acme");
  assert.equal(r.role, "Recruiter");
  assert.equal(r.location, "SP");
  assert.equal(r.degree, "2º");
});
test("saveCompanyAbout keeps good data and the numeric id; resolveCompany reads the cache without a browser", async () => {
  const url = "https://www.linkedin.com/company/acme";
  saveCompanyAbout({ url, name: "Acme", industry: "Software", size: "11-50", website: "acme.com", headquarters: "SP", company_id: "4242" });
  saveCompanyAbout({ url, name: "Acme", industry: "", size: "", website: "", headquarters: "", company_id: "" });
  const r = db.prepare(`SELECT * FROM companies WHERE url=?`).get(url) as Record<string, string>;
  assert.equal(r.industry, "Software");
  assert.equal(r.website, "acme.com");
  assert.equal(r.company_id, "4242");
  assert.deepEqual(await resolveCompany("ACME"), { id: "4242", name: "Acme", url });
});
test("COMPANY_NOT_FOUND matches PT/EN 404 pages only", () => {
  assert.ok(pure.COMPANY_NOT_FOUND.test("Esta página não existe"));
  assert.ok(pure.COMPANY_NOT_FOUND.test("This page doesn't exist"));
  assert.ok(!pure.COMPANY_NOT_FOUND.test("Acme Software"));
});

// ---- offset math (controller wiring of jobs_search.offset) ----
test("sliceSearchResults: offset inside a page, mid-page stop and end", () => {
  const cards = Array.from({ length: 50 }, (_, i) => i); // two pages starting at 25
  const r = sliceSearchResults(cards, 30, 10, false, 2);
  assert.equal(r.next_start, 40);
  const e = sliceSearchResults(cards.slice(0, 5), 25, 10, true, 1);
  assert.equal(e.next_start, null);
});

// ---- leads_find_decision_makers ----
const person = (n: string, url: string, role = "") => ({ url, name: n, degree: "2º", headline: `${n} headline`, location: "", current: "", role, company: "", mutual: "", action: "Conectar" });
const baseDeps = () => ({
  resolve: async (name: string) => (name === "Acme" ? { id: "11", name: "Acme" } : name === "NoId" ? { id: "", name: "NoId" } : null),
  search: async (_p: { keywords: string; current_company_ids: string[]; limit: number }) => [] as ReturnType<typeof person>[],
  hasTime: (_ms: number) => true,
  isAccountError: (m: string) => /^(CHECKPOINT|RATE_LIMITED)/.test(m),
});

test("cleanRoles: defaults, trims, case-insensitive dedupe, cap", () => {
  assert.deepEqual(pure.cleanRoles(undefined), pure.DEFAULT_ROLES);
  assert.deepEqual(pure.cleanRoles([" Tech  Lead ", "tech lead", "", "HR"]), ["Tech Lead", "HR"]);
  assert.equal(pure.cleanRoles(Array.from({ length: 20 }, (_, i) => `r${i}`)).length, pure.MAX_ROLES);
});

test("runLeads: resolves names, scopes search by company id, dedupes by profile url across roles", async () => {
  const calls: { keywords: string; ids: string[] }[] = [];
  const deps = {
    ...baseDeps(),
    search: async (p: { keywords: string; current_company_ids: string[]; limit: number }) => {
      calls.push({ keywords: p.keywords, ids: p.current_company_ids });
      return p.keywords === "tech lead"
        ? [person("Ana", "https://www.linkedin.com/in/ana/?miniProfileUrn=x"), person("Bia", "https://www.linkedin.com/in/bia")]
        : [person("Ana", "https://www.linkedin.com/in/ANA"), person("Caio", "https://www.linkedin.com/in/caio", "Head")];
    },
  };
  const r = await pure.runLeads(deps, { company_names: ["Acme"], roles: ["recruiter", "tech lead"] });
  assert.deepEqual(calls.map((c) => c.keywords), ["recruiter", "tech lead"]);
  assert.ok(calls.every((c) => c.ids.length === 1 && c.ids[0] === "11"));
  assert.deepEqual(r.leads.map((l) => l.person), ["Ana", "Caio", "Bia"]); // Ana kept once, from the first role
  assert.equal(r.leads[0].role, "recruiter");
  assert.equal(r.leads[0].company, "Acme");
  assert.equal(r.left.length, 0);
});

test("runLeads: limit_per_company stops further role searches", async () => {
  let n = 0;
  const deps = { ...baseDeps(), search: async () => (n++, [person("P" + n, "https://www.linkedin.com/in/p" + n), person("Q" + n, "https://www.linkedin.com/in/q" + n)]) };
  const r = await pure.runLeads(deps, { company_ids: ["5"], roles: ["a", "b", "c"], limit_per_company: 3 });
  assert.equal(r.leads.length, 3);
  assert.equal(n, 2);
});

test("runLeads: unresolved names are reported, ids need no resolve", async () => {
  let resolved = 0;
  const deps = { ...baseDeps(), resolve: async (n: string) => (resolved++, baseDeps().resolve(n)) };
  const r = await pure.runLeads(deps, { company_names: ["Nope", "NoId"], company_ids: ["9"], roles: ["x"] });
  assert.equal(resolved, 2);
  assert.deepEqual(r.unresolved.map((u) => u.company), ["Nope", "NoId"]);
  assert.equal(r.leads.length, 0);
});

test("runLeads: time budget stops with `left`, first unit always runs", async () => {
  let searches = 0;
  const deps = { ...baseDeps(), hasTime: () => false, search: async () => (searches++, [person("A", "https://www.linkedin.com/in/a")]) };
  const r = await pure.runLeads(deps, { company_ids: ["1", "2"], roles: ["r1", "r2"] });
  assert.equal(searches, 1);
  assert.equal(r.leads.length, 1);
  assert.deepEqual(r.left, [{ company: "company_id:1", roles: ["r2"] }, { company: "company_id:2", roles: ["r1", "r2"] }]);
  assert.equal(r.stopped, undefined);
});

test("runLeads: account-level error stops, keeps partial leads and lists what is left", async () => {
  let n = 0;
  const deps = {
    ...baseDeps(),
    search: async () => {
      if (++n === 2) throw new Error("CHECKPOINT: verify\nstack");
      return [person("A", "https://www.linkedin.com/in/a")];
    },
  };
  const r = await pure.runLeads(deps, { company_ids: ["1", "2"], roles: ["r1", "r2"] });
  assert.equal(r.leads.length, 1);
  assert.equal(r.stopped, "CHECKPOINT: verify");
  assert.deepEqual(r.left, [{ company: "company_id:1", roles: ["r2"] }, { company: "company_id:2", roles: ["r1", "r2"] }]);
});

test("runLeads: a non-account error is recorded and the run continues", async () => {
  let n = 0;
  const deps = { ...baseDeps(), search: async () => { if (++n === 1) throw new Error("boom"); return [person("A", "https://www.linkedin.com/in/a")]; } };
  const r = await pure.runLeads(deps, { company_ids: ["1"], roles: ["r1", "r2"] });
  assert.equal(r.errors.length, 1);
  assert.equal(r.leads.length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).stack?.split("\n").slice(0, 4).join("\n  ")}`);
  }
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir still locked */ }
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log(`all server-glue tests passed (${tests.length})`);
process.exit(0);
