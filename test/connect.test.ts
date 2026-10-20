// Run: npx tsx test/connect.test.ts
// Connect-flow rules against a saved 2026 profile page (page-maps in the data folder, local only, third-party data: names are
// read from the fixture at run time and never written here or printed). No browser: the HTML is parsed with regexes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../src/config.js";
import {
  classifyProfile, diagControls, findConnectControl, inviteHrefSlug, nameFromTitle, nameKey, profileSlug, profileTargetCheck, type PageControl,
} from "../src/linkedin/writeRules.js";

let failed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).message.replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}`);
  }
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const attr = (tag: string, a: string) => decode(tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1] ?? "");

/** Controls of a saved page, in document order, as the in-page snapshot would report them (inMenu false). */
function parseControls(html: string): PageControl[] {
  const main = html.slice(Math.max(0, html.indexOf("<main")));
  const out: PageControl[] = [];
  for (const m of main.matchAll(/<(a|button)\b([^>]*)>/g)) {
    const tag = m[2];
    out.push({ i: out.length, tag: m[1], role: attr(tag, "role"), aria: attr(tag, "aria-label"), text: "", href: attr(tag, "href"), ck: attr(tag, "componentkey"), inMenu: false });
  }
  return out;
}

// the user's own data folder (never in the repo): saved real profile pages, third-party data
const DIR = path.join(resolveDataDir(process.env, os.homedir()), "page-maps");

type Fixture = { file: string; html: string; meta: { url: string }; slug: string; name: string; controls: PageControl[]; state: string };

/** Every saved profile, classified. Several can be saved (one per state), so a test never assumes which is first. */
function loadFixtures(): Fixture[] {
  if (!fs.existsSync(DIR)) return [];
  const out: Fixture[] = [];
  for (const file of fs.readdirSync(DIR).sort()) {
    if (!/^_in_.+\.html$/.test(file) || !fs.existsSync(path.join(DIR, file.replace(/\.html$/, ".json")))) continue;
    const html = fs.readFileSync(path.join(DIR, file), "utf8");
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(/\.html$/, ".json")), "utf8")) as { url: string };
    const slug = profileSlug(meta.url);
    const name = nameFromTitle(decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""));
    if (!slug || !name) continue;
    const controls = parseControls(html);
    out.push({ file, html, meta, slug, name, controls, state: classifyProfile(controls, name, slug) });
  }
  return out;
}

const fixtures = loadFixtures();
// Labels never include the file name or the person: only the state is printed.
const withState = (state: string) => fixtures.find((f) => f.state === state);

const connectFx = withState("connect");
if (!connectFx) console.log("SKIP connect fixture tests: no connect fixture (local page-maps in the data folder only)");
else {
  const { html, meta, slug, name, controls } = connectFx;

  t("fixture: the 2026 profile has no <h1>, so the name must come from <title>", () => {
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 0);
    assert.ok(slug, "slug from the saved URL");
    assert.ok(name && !/linkedin/i.test(name) && !name.includes("|"), "name from the title");
    assert.ok(nameKey(name).split(" ").length >= 2);
  });

  t("fixture: the connect control is the custom-invite link for THIS slug whose aria-label names the person", () => {
    const c = findConnectControl(controls, slug, name);
    assert.ok(!("reason" in c), JSON.stringify(c));
    assert.equal(inviteHrefSlug(c.href), slug);
    assert.match(c.ck, /_connect$/);
    assert.ok(c.tag === "a", "it is a link, not a button");
  });

  t("fixture: suggestion-card invite links (other people) are never chosen", () => {
    const others = controls.filter((c) => inviteHrefSlug(c.href) && inviteHrefSlug(c.href) !== slug);
    assert.ok(others.length >= 3, "the page has suggestion invite links");
    for (const o of others) {
      const oSlug = inviteHrefSlug(o.href)!;
      // our person's name on another slug, or another slug's own name while we look for our person: both rejected
      assert.ok("reason" in findConnectControl(controls, oSlug, name), "another slug with our name");
      const c = findConnectControl(controls, slug, name);
      assert.ok(!("reason" in c) && inviteHrefSlug(c.href) === slug);
    }
    // only suggestion links left on the page: nothing to click
    const onlyOthers = controls.filter((c) => !(inviteHrefSlug(c.href) === slug));
    assert.deepEqual(findConnectControl(onlyOthers, slug, name), { reason: "only_other_profiles_connect_links" });
  });

  t("fixture: the slug must match exactly (no prefix / partial slug)", () => {
    assert.ok("reason" in findConnectControl(controls, slug.slice(0, -1), name));
    assert.ok("reason" in findConnectControl(controls, `${slug}x`, name));
  });

  t("fixture: a link for our slug that names someone else is rejected", () => {
    const tampered = controls.map((c) => (inviteHrefSlug(c.href) === slug ? { ...c, aria: "Convidar Pessoa Inventada para se conectar" } : c));
    assert.deepEqual(findConnectControl(tampered, slug, name), { reason: "connect_link_names_someone_else" });
  });

  t("fixture: state is 'connect' (2nd degree: Seguir + Mais + invite link)", () => {
    assert.equal(connectFx.state, "connect");
    assert.ok(controls.some((c) => /^seguir /i.test(c.aria) && nameKey(c.aria).includes(nameKey(name))));
  });

  t("fixture: diag lists control labels/hrefs only, at most 15", () => {
    const d = diagControls(controls, name);
    assert.ok(d.length > 0 && d.length <= 1800);
    assert.ok(d.split(" | ").length <= 15);
    assert.ok(d.includes("custom-invite"));
  });

  t("fixture: identity check uses the title name (opaque id + cached name)", () => {
    const pageUrl = meta.url;
    assert.equal(profileTargetCheck({ slug, pageUrl, h1: name }), null);
    assert.equal(profileTargetCheck({ slug: "ACoAABcdefghijklmnop", pageUrl, h1: name, expected: name }), null);
    assert.match(profileTargetCheck({ slug: "ACoAABcdefghijklmnop", pageUrl, h1: name, expected: "Pessoa Inventada" })!, /name_mismatch/);
  });
}

const pendingFx = withState("pending");
if (!pendingFx) console.log("SKIP pending fixture tests: no pending fixture (local page-maps in the data folder only)");
else {
  t("fixture: a Pendente profile is classified pending and offers no connect control to click", () => {
    assert.equal(pendingFx.state, "pending");
    const r = findConnectControl(pendingFx.controls, pendingFx.slug, pendingFx.name);
    // nothing of this person's to click: only suggestion cards' invites, or none at all
    assert.ok("reason" in r && ["only_other_profiles_connect_links", "no_connect_control"].includes(r.reason), JSON.stringify(r));
  });
}

// --- synthetic (fake names) -------------------------------------------------------------------------
const C = (o: Partial<PageControl>): PageControl => ({ i: 0, tag: "a", role: "", aria: "", text: "", href: "", ck: "", inMenu: false, ...o });

t("nameFromTitle: notification count and suffix removed", () => {
  assert.equal(nameFromTitle("Maria Silva | LinkedIn"), "Maria Silva");
  assert.equal(nameFromTitle("(3) Maria Silva | LinkedIn"), "Maria Silva");
  assert.equal(nameFromTitle("(99+) Maria  Silva - LinkedIn"), "Maria Silva");
  assert.equal(nameFromTitle("LinkedIn"), "LinkedIn");
});

t("inviteHrefSlug: custom-invite links only", () => {
  assert.equal(inviteHrefSlug("/preload/custom-invite/?vanityName=Maria-Silva"), "maria-silva");
  assert.equal(inviteHrefSlug("https://www.linkedin.com/preload/custom-invite/?vanityName=ana%2Dlima"), "ana-lima");
  assert.equal(inviteHrefSlug("/in/maria-silva/"), null);
  assert.equal(inviteHrefSlug("/preload/custom-invite/"), null);
});

t("classifyProfile: pending, connected, more, follow-only, none", () => {
  const n = "Maria Silva";
  assert.equal(classifyProfile([C({ aria: "Pendente, clique para retirar o convite enviado para Maria Silva", tag: "button" })], n, "maria"), "pending");
  assert.equal(classifyProfile([C({ aria: "Maria Silva Perfil 1º" })], n, "maria"), "connected");
  assert.equal(classifyProfile([C({ aria: "Seguir Maria Silva", tag: "button" }), C({ aria: "Mais", tag: "button" })], n, "maria"), "more");
  assert.equal(classifyProfile([C({ aria: "Seguir Maria Silva", tag: "button" })], n, "maria"), "follow_only");
  assert.equal(classifyProfile([C({ aria: "Seguir Outra Pessoa", tag: "button" })], n, "maria"), "none");
  // someone else's Pending (a suggestion card) does not make our person pending
  assert.equal(classifyProfile([C({ aria: "Pendente, convite para Outra Pessoa", tag: "button" }), C({ aria: "Convidar Maria Silva para se conectar", href: "/preload/custom-invite/?vanityName=maria" })], n, "maria"), "connect");
});

t("findConnectControl: 'More' menu items (no href) only when they name our person or nobody", () => {
  const n = "Maria Silva";
  assert.equal((findConnectControl([C({ i: 4, role: "menuitem", aria: "Convidar Maria Silva para se conectar", inMenu: true })], "maria", n) as PageControl).i, 4);
  assert.equal((findConnectControl([C({ i: 5, role: "menuitem", text: "Conectar", inMenu: true })], "maria", n) as PageControl).i, 5);
  assert.ok("reason" in findConnectControl([C({ role: "menuitem", aria: "Convidar Outra Pessoa para se conectar", inMenu: true })], "maria", n));
  assert.ok("reason" in findConnectControl([C({ role: "button", aria: "Conectar" })], "maria", n), "an unnamed Connect outside a menu could be anyone's");
});

t("invite UI = the VISIBLE dialog with the invite text (2026: shadow-root modal + hidden ad dialogs); clicks report their step", () => {
  // people.ts drives the page and cannot run here: source-level checks of the 2026 fix.
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", "people.ts"), "utf8");
  assert.match(src, /const shownOverlays = \(page: Page\) => page\.locator\(OVERLAYS\)\.filter\(\{ visible: true \}\)/);
  assert.match(src, /inviteDialog = \(page: Page\) => shownOverlays\(page\)\.filter\(\{ hasText: INVITE_MODAL_RE \}\)\.last\(\)/);
  assert.match(src, /const ui = \(await modal\.count\(\)\) \? modal : page\.locator\("main"\)\.first\(\);/);
  assert.doesNotMatch(src, /page\.locator\(OVERLAYS\)\.last\(\)/); // "the last dialog" was a hidden one
  for (const step of ["more_menu", "connect_control", "add_note", "note_box"]) assert.match(src, new RegExp(`step = "${step}"`));
  assert.match(src, /return await fail\(`\$\{step\}: \$\{clip\(msg, 160\)\}`\)/);
});

if (failed) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall connect tests passed");
