// Messages to 1st-degree connections: pure control/composer/text rules (synthetic controls, fake names) and
// message_prepare filtering + batch gating on a temp SQLite file (never data/linkedin.db, no browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ComposerSnap, ConvMessage } from "../src/linkedin/messageRules.js";
import type { PageControl } from "../src/linkedin/writeRules.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-li-t7-"));
process.env.LINKEDIN_DB = path.join(tmp, "data.db");

const R = await import("../src/linkedin/messageRules.js");
const L = await import("../src/guard/ledger.js");
const { db } = await import("../src/store/db.js");
const { messageExecutePlan, prepareMessageBatch } = await import("../src/linkedin/message.js");

const C = (o: Partial<PageControl>): PageControl => ({ i: 0, tag: "a", role: "", aria: "", text: "", href: "", ck: "", inMenu: false, ...o });
const S = (o: Partial<ComposerSnap>): ComposerSnap => ({ i: 0, titles: [], pills: [], text: "", boxText: "", boxes: 1, focused: false, fullPage: false, buttons: [], ...o });
const N = "Maria Silva";
const isPick = (x: unknown): x is PageControl | ComposerSnap => !!x && typeof x === "object" && !("reason" in x);
const reason = (x: object) => ("reason" in x ? (x as { reason: string }).reason : "picked");

// ---- control selection ----

test("findMessageControl: picks the control naming THIS person (PT and EN)", () => {
  const pt = [C({ i: 1, aria: "Seguir Maria Silva", tag: "button" }), C({ i: 2, aria: "Enviar mensagem para Maria Silva", href: "/messaging/compose/?recipient=ACoAAX" })];
  assert.equal((R.findMessageControl(pt, N, "maria-silva") as PageControl).i, 2);
  const en = [C({ i: 3, aria: "Message Maria Silva", tag: "button" })];
  assert.equal((R.findMessageControl(en, N, "maria-silva") as PageControl).i, 3);
});

test("findMessageControl: suggestion-card controls for other people are never chosen", () => {
  const others = [C({ i: 1, aria: "Enviar mensagem para Outra Pessoa" }), C({ i: 2, aria: "Message Ana Lima", tag: "button" })];
  assert.equal(reason(R.findMessageControl(others, N, "maria-silva")), "only_other_profiles_message_controls");
  const mixed = [...others, C({ i: 9, aria: "Enviar mensagem para Maria Silva" })];
  assert.equal((R.findMessageControl(mixed, N, "maria-silva") as PageControl).i, 9);
  // first name alone, or a link to another /in/ slug, is not this person
  assert.ok(!isPick(R.findMessageControl([C({ aria: "Enviar mensagem para Maria" })], N, "maria-silva")));
  assert.ok(!isPick(R.findMessageControl([C({ aria: "Mensagem", href: "/in/outra-pessoa/" })], N, "maria-silva")));
  // controls inside other menus never count
  assert.ok(!isPick(R.findMessageControl([C({ aria: "Enviar mensagem para Maria Silva", inMenu: true })], N, "maria-silva")));
});

test("findMessageControl: InMail / Premium / credits upsells are refused", () => {
  assert.equal(reason(R.findMessageControl([C({ aria: "Enviar InMail para Maria Silva", tag: "button" })], N, "m")), "inmail_refused");
  assert.equal(reason(R.findMessageControl([C({ aria: "Mensagem", href: "https://www.linkedin.com/premium/products/?upsell=1" })], N, "m")), "inmail_refused");
  assert.equal(reason(R.findMessageControl([C({ aria: "Message Maria Silva (Premium)" })], N, "m")), "inmail_refused");
  // an upsell for this person wins over a plain control (fail closed)
  const both = [C({ i: 1, aria: "Enviar mensagem para Maria Silva" }), C({ i: 2, aria: "Enviar InMail para Maria Silva" })];
  assert.equal(reason(R.findMessageControl(both, N, "m")), "inmail_refused");
  // someone else's upsell (another card) does not block our person's control
  assert.equal((R.findMessageControl([C({ i: 4, aria: "Enviar InMail para Outra Pessoa" }), C({ i: 5, aria: "Message Maria Silva" })], N, "m") as PageControl).i, 5);
});

test("findMessageControl: a bare 'Mensagem' when it is the only unnamed message control; nav 'Mensagens' ignored", () => {
  assert.equal((R.findMessageControl([C({ i: 7, text: "Mensagem", tag: "button" })], N, "m") as PageControl).i, 7);
  assert.equal(reason(R.findMessageControl([C({ text: "Mensagem" }), C({ text: "Message" })], N, "m")), "message_control_ambiguous");
  // 2026 profile UI: own control is an unnamed compose link; suggestion cards name other people
  const live = [
    C({ i: 1, text: "Enviar mensagem", href: "https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AA" }),
    C({ i: 2, aria: "Enviar mensagem a Outra Pessoa", href: "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AB" }),
    C({ i: 3, aria: "Enviar mensagem a Ana Lima", href: "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AC" }),
  ];
  assert.equal((R.findMessageControl(live, N, "m") as PageControl).i, 1);
  assert.equal((R.findMessageControl([C({ i: 4, text: "Mensagem" }), C({ aria: "Enviar mensagem para Outra Pessoa" })], N, "m") as PageControl).i, 4);
  // two unnamed controls, or an unnamed one pointing elsewhere next to other people's controls, stay ambiguous
  assert.equal(reason(R.findMessageControl([...live, C({ i: 5, text: "Mensagem", href: "/messaging/compose/?profileUrn=x" })], N, "m")), "message_control_ambiguous");
  assert.equal(reason(R.findMessageControl([C({ text: "Mensagem", href: "/messaging/thread/123/" }), live[1]], N, "m")), "message_control_ambiguous");
  // the same compose link repeated (top card + sticky header) is one control; two recipients stay ambiguous
  const sticky = C({ i: 6, text: "Enviar mensagem", href: "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AA&recipient=A&interop=msgOverlay" });
  assert.equal((R.findMessageControl([...live, sticky], N, "m") as PageControl).i, 1);
  const otherUrn = C({ i: 7, text: "Enviar mensagem", href: "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AZ" });
  assert.equal(reason(R.findMessageControl([...live, otherUrn], N, "m")), "message_control_ambiguous");
  // an unnamed one inside a menu never counts
  assert.equal(reason(R.findMessageControl([{ ...live[0], inMenu: true }, live[1]], N, "m")), "only_other_profiles_message_controls");
  assert.equal(reason(R.findMessageControl([C({ text: "Mensagens", href: "/messaging/" }), C({ text: "Messaging" })], N, "m")), "no_message_control");
  assert.equal(R.messageLabelName("Enviar mensagem para Maria Silva"), "Maria Silva");
  assert.equal(R.messageLabelName("Message Maria Silva"), "Maria Silva");
  assert.equal(R.messageLabelName("Mensagem"), null);
});

// ---- degree ----

test("degreeOnPage: 1st from a named control or the top-card line after the name", () => {
  assert.equal(R.degreeOnPage([C({ aria: "Maria Silva Perfil 1º" })], [], N, "m"), "1st");
  assert.equal(R.degreeOnPage([C({ aria: "Remover conexão com Maria Silva", inMenu: true })], [], N, "m"), "1st");
  assert.equal(R.degreeOnPage([], ["Maria Silva", "· 1º", "Engenheira de Dados"], N, "m"), "1st");
  assert.equal(R.degreeOnPage([], ["Maria Silva · 1st", "Data Engineer"], N, "m"), "1st");
  assert.equal(R.degreeOnPage([], ["Maria Silva", "(Ela/Dela)", "· 1º grau"], N, "m"), "1st");
});

test("degreeOnPage: 2nd/3rd, Pending or an invite link for this person -> not_1st; nothing -> unknown", () => {
  assert.equal(R.degreeOnPage([], ["Maria Silva", "· 2º"], N, "m"), "not_1st");
  assert.equal(R.degreeOnPage([], ["Maria Silva · 3º+"], N, "m"), "not_1st");
  assert.equal(R.degreeOnPage([C({ aria: "Maria Silva Perfil 1º" }), C({ aria: "Pendente, clique para retirar o convite enviado para Maria Silva", tag: "button" })], [], N, "m"), "not_1st");
  assert.equal(R.degreeOnPage([C({ aria: "Convidar Maria Silva para se conectar", href: "/preload/custom-invite/?vanityName=m" })], ["Maria Silva", "· 1º"], N, "m"), "not_1st");
  assert.equal(R.degreeOnPage([], ["Maria Silva", "Engenheira de Dados", "São Paulo"], N, "m"), "unknown");
  // a 1st-degree marker belonging to someone else (suggestion card) proves nothing
  assert.equal(R.degreeOnPage([C({ aria: "Outra Pessoa Perfil 1º" })], ["Maria Silva", "Engenheira"], N, "m"), "unknown");
  assert.equal(R.degreeOnPage([], ["Outra Pessoa", "· 1º"], N, "m"), "unknown");
  assert.ok(R.isFirstDegreeLabel("1º") && R.isFirstDegreeLabel("• 1st") && !R.isFirstDegreeLabel("2º") && !R.isFirstDegreeLabel(""));
});

// ---- composer / recipient ----

test("pickComposer: the composer naming this person (focused first); others' bubbles ignored", () => {
  const other = S({ i: 0, titles: ["Outra Pessoa"] });
  const mine = S({ i: 1, titles: ["Maria Silva"], focused: true });
  assert.equal((R.pickComposer([other, mine], N) as ComposerSnap).i, 1);
  assert.equal((R.pickComposer([other, S({ i: 2, titles: ["Maria Silva"] })], N) as ComposerSnap).i, 2);
  assert.equal(reason(R.pickComposer([other], N)), "recipient_mismatch");
  assert.equal(reason(R.pickComposer([], N)), "composer_not_found");
  assert.equal(reason(R.pickComposer([S({ i: 0, titles: ["Maria Silva"] }), S({ i: 1, titles: ["Maria Silva"] })], N)), "composer_ambiguous");
  assert.equal(reason(R.pickComposer([S({ titles: ["Maria Silva"], boxes: 2 })], N)), "composer_ambiguous");
});

test("pickComposer: group conversations, several or wrong recipient chips are refused", () => {
  assert.equal(reason(R.pickComposer([S({ titles: ["Maria Silva, João Souza"] })], N)), "recipient_mismatch");
  assert.equal(reason(R.pickComposer([S({ titles: ["Maria Silva e João Souza"] })], N)), "recipient_mismatch");
  assert.equal(reason(R.pickComposer([S({ titles: ["Nova mensagem"], pills: ["Maria Silva", "João Souza"] })], N)), "multiple_recipients");
  assert.equal(reason(R.pickComposer([S({ titles: ["Maria Silva"], pills: ["João Souza"] })], N)), "recipient_mismatch");
  assert.equal((R.pickComposer([S({ i: 3, titles: ["Nova mensagem"], pills: ["Maria Silva"] })], N) as ComposerSnap).i, 3);
  assert.ok(R.titleIsPerson("Maria Silva", N) && R.titleIsPerson("maria  silva", N) && !R.titleIsPerson("Maria", N));
});

test("pickComposer: InMail / Premium / credits wording in the composer -> inmail_refused (unless upsell:false)", () => {
  for (const t of ["Enviar InMail", "Experimente o Premium grátis", "Try Premium for free", "Use 1 de 5 créditos", "You have 3 credits left"]) {
    assert.equal(reason(R.pickComposer([S({ titles: ["Maria Silva"], text: `Maria Silva ${t}` })], N)), "inmail_refused", t);
  }
  assert.equal(reason(R.pickComposer([S({ titles: ["Nova mensagem"], text: "Enviar InMail" })], N)), "inmail_refused");
  assert.ok(isPick(R.pickComposer([S({ titles: ["Maria Silva"], text: "premium" })], N, { upsell: false })));
  assert.ok(isPick(R.pickComposer([S({ titles: ["Maria Silva"], text: "Maria Silva Olá! Escreva uma mensagem" })], N)));
});

test("composer helpers: close target, single Send, close button, empty box", () => {
  const mine = S({ i: 1, titles: ["Maria Silva"] });
  assert.deepEqual(R.composerToClose([S({ i: 0, titles: ["Outra"] }), mine], N), { s: mine, named: true });
  const f = S({ i: 2, titles: ["Outra"], focused: true });
  assert.deepEqual(R.composerToClose([f], N), { s: f, named: false });
  assert.equal(R.composerToClose([S({ titles: ["Outra"] })], N), null);
  assert.equal(R.composerToClose([mine, S({ i: 5, titles: ["Maria Silva"] })], N), "ambiguous");
  const b = (label: string, k = 0, disabled = false) => ({ k, label, disabled });
  assert.equal(R.sendButton(S({ buttons: [b("Anexar", 0), b("Enviar", 1)] }))?.k, 1);
  assert.equal(R.sendButton(S({ buttons: [b("Enviar", 0), b("Send", 1)] })), null);
  assert.equal(R.sendButton(S({ buttons: [b("Enviar convite", 0)] })), null);
  assert.equal(R.closeButton(S({ buttons: [b("Minimizar", 0), b("Fechar", 1), b("Fechar sua conversa com Maria Silva", 2)] }))?.k, 2);
  assert.equal(R.closeButton(S({ buttons: [b("Minimize", 0), b("Close", 1)] }))?.k, 1);
  assert.equal(R.closeButton(S({ buttons: [b("Minimizar", 0)] })), null);
  // 2026 new-message bubble (live): titled "Nova mensagem", the person only in the recipient chip,
  // Send disabled until text is typed, closed by "Fechar rascunho da conversa"
  const live = S({
    titles: ["Nova mensagem"], pills: ["Maria Silva"],
    buttons: ["Comprimir conversa", "Fechar rascunho da conversa", "Remover Maria Silva", "Exibir destinatários sugeridos para sua mensagem",
      "Anexar imagem ao rascunho da conversa", "Enviar", "Abrir opções de envio"].map((l, k) => b(l, k, l === "Enviar")),
  });
  assert.equal((R.pickComposer([live], N) as ComposerSnap).i, 0);
  assert.deepEqual(R.sendButton(live), { k: 5, label: "Enviar", disabled: true });
  assert.equal(R.closeButton(live)?.label, "Fechar rascunho da conversa");
  assert.equal(R.closeButton(S({ buttons: [b("Close your draft conversation", 0)] }))?.k, 0);
  assert.equal(R.closeButton(S({ buttons: [b("Fechar rascunho", 0)] })), null, "never a bare draft control");
  assert.ok(R.isEmptyBox("") && R.isEmptyBox(" \n ") && R.isEmptyBox("Escreva uma mensagem…") && !R.isEmptyBox("Oi"));
});

test("closeDecision: typed text in a composer that cannot be identified / is still open is never reported closed", () => {
  const mine = { s: S({ titles: ["Maria Silva"] }), named: true };
  const fallback = { s: S({ titles: ["Outra Pessoa"], focused: true }), named: false };
  const st = (clear: boolean, namedSeen = false, fallbackTried = false) => ({ clear, namedSeen, fallbackTried });
  // typed, and no composer naming the person was ever identified -> not closed (DISCARD_FAILED stop)
  assert.equal(R.closeDecision(null, st(true)), "not_closed");
  // typed, the focused fallback is still there after its one attempt -> not closed (and never cleared)
  assert.equal(R.closeDecision(fallback, st(true, false, true)), "not_closed");
  assert.equal(R.closeDecision(fallback, st(true)), "act", "the fallback gets one close attempt");
  // nothing typed: no composer left, or an untouched fallback still open, is clean
  assert.equal(R.closeDecision(null, st(false)), "closed");
  assert.equal(R.closeDecision(fallback, st(false, false, true)), "closed");
  // typed into the named composer, cleared and closed: it is gone -> closed
  assert.equal(R.closeDecision(mine, st(true)), "act");
  assert.equal(R.closeDecision(null, st(true, true)), "closed");
  // once the named one is gone, focus moving to another conversation never makes us touch it
  assert.equal(R.closeDecision(fallback, st(true, true)), "closed");
  assert.equal(R.closeDecision("ambiguous", st(false)), "not_closed");
});

// ---- text ----

test("sameMessageText: whitespace/newline/nbsp/zero-width normalised; case and words count", () => {
  assert.ok(R.sameMessageText("Olá Maria,\n\nTudo bem?", "Olá Maria, Tudo bem?"));
  assert.ok(R.sameMessageText("Olá Maria ", " Olá Maria"));
  assert.ok(R.sameMessageText("Ol​á", "Olá"));
  assert.ok(R.sameMessageText("Olá", "Olá"), "NFC");
  assert.ok(!R.sameMessageText("olá maria", "Olá Maria"));
  assert.ok(!R.sameMessageText("Olá Maria", "Olá Maria!"));
  assert.ok(!R.sameMessageText("", ""), "empty never matches");
});

test("cleanMessageInput: invisible characters stripped, CRLF -> LF, trimmed, bounded", () => {
  assert.equal(R.cleanMessageInput("  Oi\r\nMaria​  "), "Oi\nMaria");
  assert.throws(() => R.cleanMessageInput(" ​ "), /empty/);
  assert.throws(() => R.cleanMessageInput("x".repeat(R.MESSAGE_MAX + 1)), /max/);
});

test("messageTextPlan: only the stored text, only while its SHA-256 matches", () => {
  const text = "Oi Maria, tudo bem?";
  assert.equal(R.messageTextPlan({ text, text_sha256: R.textHash(text) }), text);
  assert.throws(() => R.messageTextPlan({ text: `${text}!`, text_sha256: R.textHash(text) }), /integrity|SHA-256/);
  assert.throws(() => R.messageTextPlan({ text, text_sha256: "0".repeat(64) }), /integrity/);
  assert.throws(() => R.messageTextPlan({ text }), /no prepared message text/);
  assert.throws(() => R.messageTextPlan(undefined), /no prepared message text/);
  assert.match(R.textHash(text), /^[0-9a-f]{64}$/);
});

test("sendVerified: the user's last message equals the text and is new", () => {
  const text = "Oi Maria, tudo bem?";
  const them = (t: string): ConvMessage => ({ own: false, sender: N, text: t });
  const me = (t: string, own: boolean | null = true, sender = ""): ConvMessage => ({ own, sender, text: t });
  assert.ok(R.sendVerified([them("Olá")], [them("Olá"), me(text)], text, N));
  assert.ok(R.sendVerified([], [me("Oi Maria,\n tudo bem?", null, "Fulano Detal")], text, N), "own by sender != recipient");
  assert.ok(!R.sendVerified([], [them(text)], text, N), "the recipient's message is not ours");
  assert.ok(!R.sendVerified([me(text)], [me(text)], text, N), "an old identical message proves nothing");
  assert.ok(R.sendVerified([me(text)], [me(text), me(text)], text, N), "a second copy is new");
  assert.ok(!R.sendVerified([], [me(text), me("depois")], text, N), "not the last own message");
  assert.ok(!R.sendVerified([], [me(text, null, "")], text, N), "unknown author never counts");
  assert.ok(!R.sendVerified([], [me("Oi Maria")], text, N));
  // the composer is cleared by a real send: the text still in it means it did not go out
  assert.ok(R.sendVerified([them("Olá")], [them("Olá"), me(text)], text, N, ""));
  assert.ok(R.sendVerified([them("Olá")], [them("Olá"), me(text)], text, N, "Escreva uma mensagem..."), "placeholder = empty");
  assert.ok(!R.sendVerified([them("Olá")], [them("Olá"), me(text)], text, N, text), "text still in the box");
  assert.ok(!R.sendVerified([], [me(text)], text, N, "Oi Maria"), "a draft left in the box");
});

// ---- ledger: dry runs and the 7-day window ----

const ago = (days: number) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 19).replace("T", " ");
const P = (slug: string) => `https://www.linkedin.com/in/${slug}/`;
const action = (slug: string, status: string, detail: string, days: number) =>
  db.prepare(`INSERT INTO actions (type,target,status,detail,ts) VALUES ('message',?,?,?,?)`).run(P(slug), status, detail, ago(days));

test("recentMessageIn: 7-day window; failed before typing does not block, failed after typing does", () => {
  action("r-done", "done", "done", 3);
  action("r-old", "done", "done", 8);
  action("r-unver", "unverified", "unverified: sent_message_not_seen", 1);
  action("r-fail", "failed", "failed: not_connected", 1);
  action("r-typed", "failed", "failed: typed_text_mismatch", 1);
  assert.equal(L.recentMessageIn(db, P("r-done")), "done");
  assert.equal(L.recentMessageIn(db, P("r-old")), undefined);
  assert.equal(L.recentMessageIn(db, P("r-unver")), "unverified");
  assert.equal(L.recentMessageIn(db, P("r-fail")), undefined);
  assert.equal(L.recentMessageIn(db, P("r-typed")), "failed after typing");
  assert.equal(L.MESSAGE_REPEAT_DAYS, 7);
});

test("recentMessageIn reads what withReservation writes: a typed failure blocks a repeat, an untyped one does not", async () => {
  const limits = { apply_daily: 25, connect_daily: 15, connect_weekly: 100, message_daily: 20 };
  await L.withReservation(db, limits, "message", P("w-typed"), async () => ({ status: "failed" as const, reason: `${L.TYPED_REASON}text_mismatch` }));
  await L.withReservation(db, limits, "message", P("w-untyped"), async () => ({ status: "failed" as const, reason: "not_connected" }));
  assert.equal(L.recentMessageIn(db, P("w-typed")), "failed after typing");
  assert.equal(L.recentMessageIn(db, P("w-untyped")), undefined);
});

test("reopens: dry_run_ok leaves the item open", () => {
  assert.ok(L.reopens({ status: "dry_run_ok" }));
  assert.ok(!L.reopens({ status: "failed", reason: "typed_text_mismatch" }));
  assert.ok(!L.reopens({ status: "failed", reason: "typed_CHECKPOINT: x" }), "typed + account-level never reopens");
});

// ---- message_prepare ----

const person = (slug: string, name: string, degree: string | null, headline = "Engenheira de Dados") =>
  db.prepare(`INSERT INTO people (url,name,headline,degree) VALUES (?,?,?,?)`).run(`https://www.linkedin.com/in/${slug}/?miniProfile=x`, name, headline, degree);

test("message_prepare: filters degree / 7-day repeats / quota, stores text + hash, sends nothing", () => {
  person("p-first", "Maria Silva", "1º");
  person("p-second", "Ana Lima", "2º");
  person("p-nodeg", "Bia Souza", null);
  action("p-recent", "done", "done", 2);
  action("p-failed", "failed", "failed: inmail_refused", 1);
  const before = (db.prepare(`SELECT COUNT(*) n FROM actions`).get() as { n: number }).n;
  const r = prepareMessageBatch(
    db,
    { profile_ids: ["p-first", "https://www.linkedin.com/in/P-First/", "p-second", "p-nodeg", "p-recent", "p-failed", "p-uncached", "not a url!", "p-extra"], text: " Oi!\r\nTudo bem?​ " },
    { remaining: 4, ttlMin: 30 },
  );
  assert.ok(r.batch_id);
  assert.deepEqual(r.candidates.map((c) => c.id), [P("p-first"), P("p-nodeg"), P("p-failed"), P("p-uncached")]);
  assert.equal(r.candidates[0].name, "Maria Silva");
  assert.equal(r.candidates[0].verify_note, undefined);
  assert.match(r.candidates[1].verify_note ?? "", /verified on the page/);
  assert.match(r.candidates[3].verify_note ?? "", /verified on the page/);
  const why = Object.fromEntries((r.rejected ?? []).map((x) => [x.input, x.reason]));
  assert.match(why[P("p-second")], /not_connected/);
  assert.match(why[P("p-recent")], /already messaged in the last 7 days \(done\)/);
  assert.match(why[P("p-extra")], /over_quota/);
  assert.match(why["not a url!"], /not a linkedin/);
  assert.equal(r.text, "Oi!\nTudo bem?");
  // the batch meta holds exactly the shown text and its hash; execute's gate accepts it
  const row = db.prepare(`SELECT items FROM batches WHERE id=?`).get(r.batch_id) as { items: string };
  const meta = L.parseBatch(row.items).meta!;
  assert.equal(meta.text, "Oi!\nTudo bem?");
  assert.equal(meta.text_sha256, r.text_sha256);
  assert.equal(R.messageTextPlan(meta), r.text);
  assert.deepEqual(meta.names, { [P("p-first")]: "Maria Silva", [P("p-nodeg")]: "Bia Souza" });
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM actions`).get() as { n: number }).n, before, "prepare reserves nothing");
});

test("message_prepare: nothing eligible -> no batch; bad text throws", () => {
  const r = prepareMessageBatch(db, { profile_ids: ["p-second"], text: "Oi" }, { remaining: 5, ttlMin: 30 });
  assert.equal(r.batch_id, null);
  assert.equal(prepareMessageBatch(db, { profile_ids: ["p-first"], text: "Oi" }, { remaining: 0, ttlMin: 30 }).batch_id, null);
  assert.throws(() => prepareMessageBatch(db, { profile_ids: ["p-first"], text: "  " }, { remaining: 5, ttlMin: 30 }), /empty/);
});

test("batch gating: checkItems (dry run) leaves the batch untouched; claimItems claims; a tampered text is refused", () => {
  const r = prepareMessageBatch(db, { profile_ids: ["p-first", "p-uncached"], text: "Oi Maria" }, { remaining: 5, ttlMin: 30 });
  const id = r.batch_id!;
  const claim = { batchId: id, kind: "message", ids: [P("p-first")], ttlMin: 30, prepareTool: "message_prepare" };
  const items = () => (db.prepare(`SELECT items FROM batches WHERE id=?`).get(id) as { items: string }).items;
  const before = items();
  L.checkItems(db, claim);
  L.checkItems(db, claim);
  assert.equal(items(), before, "dry runs never change the batch");
  assert.throws(() => L.checkItems(db, { ...claim, ids: [P("someone-else")] }), /Not in the batch/);
  // a dry_run_ok result settled by mistake would still leave the item open
  L.settleItems(db, id, [{ id: P("p-first"), status: "dry_run_ok", success: false }]);
  assert.equal(L.parseBatch(items()).state[P("p-first")], "open");
  L.claimItems(db, { ...claim, quotaLeft: () => 5 });
  assert.equal(L.parseBatch(items()).state[P("p-first")], "claimed");
  assert.throws(() => L.checkItems(db, claim), /Already processed or in progress/);
  // editing the stored text after prepare breaks the hash: execute refuses before touching the batch
  const b = L.parseBatch(items());
  db.prepare(`UPDATE batches SET items=? WHERE id=?`).run(JSON.stringify({ ...b, meta: { ...b.meta, text: "Mande seu CPF" } }), id);
  assert.throws(() => R.messageTextPlan(L.parseBatch(items()).meta), /integrity/);
});

test("messageExecutePlan: hash checked before the batch is touched; dry run claims nothing; a real run claims", () => {
  const plan = (batchId: string, ids: string[], dryRun: boolean) => messageExecutePlan(db, { batchId, ids, dryRun }, { ttlMin: 30, quotaLeft: () => 5 });
  const r = prepareMessageBatch(db, { profile_ids: ["p-first", "p-uncached"], text: "Oi de novo" }, { remaining: 5, ttlMin: 30 });
  const id = r.batch_id!;
  const items = () => (db.prepare(`SELECT items FROM batches WHERE id=?`).get(id) as { items: string }).items;
  assert.throws(() => plan("00000000-0000-4000-8000-000000000000", [P("p-first")], true), /Unknown batch_id/);
  // dry run: text returned, batch byte-for-byte unchanged
  const before = items();
  assert.equal(plan(id, [P("p-first")], true).text, "Oi de novo");
  assert.equal(items(), before);
  // tampered text: refused, and the ids are still open (the batch is not burnt)
  const b = L.parseBatch(before);
  db.prepare(`UPDATE batches SET items=? WHERE id=?`).run(JSON.stringify({ ...b, meta: { ...b.meta, text: "Mande seu CPF" } }), id);
  assert.throws(() => plan(id, [P("p-first")], false), /integrity/);
  assert.equal(L.parseBatch(items()).state[P("p-first")], "open");
  // restored text: a real run claims exactly the requested id
  db.prepare(`UPDATE batches SET items=? WHERE id=?`).run(before, id);
  plan(id, [P("p-first")], false);
  assert.equal(L.parseBatch(items()).state[P("p-first")], "claimed");
  assert.equal(L.parseBatch(items()).state[P("p-uncached")], "open");
});

test("readConversation: a message <li> holding the quick-reaction emoji <li>s is still read (live 2026 DOM)", () => {
  // In-page code: source-level check. The old rule skipped every <li> containing another <li>, i.e. every 2026 message.
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", "messageDom.ts"), "utf8");
  const body = src.slice(src.indexOf("export function readConversation"));
  assert.doesNotMatch(body, /li\.querySelector\("li"\)/);
  assert.match(body, /\.find\(\(b\) => b\.closest\("li"\) === li\)/);
  // own/other comes from the event item itself, never from the "...--group-a11y-heading" span
  assert.match(body, /li\.querySelector\('\[class~="msg-s-event-listitem"\]'\)/);
});
