// Run: npx tsx test/mapper.test.ts   (DOM-free helpers only; mapper.ts itself needs a browser and is not imported)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bankSecrets, clipSteps, emptyReason, finalizeStep, maskEmail, maskSteps, noEasyApplyError, pickOptionLabel, type MappedStep, type OptSrc, type RawStep } from "../src/linkedin/mapperPure.js";

let failed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e as Error).message}`);
  }
}
const src = (o: Partial<OptSrc>): OptSrc => ({ labelFor: "", aria: "", sibling: "", wrapper: "", value: "on", checked: false, groupLabel: "Você tem conhecimento de Power BI?*", ...o });

t("radio options never degrade to the literal 'on'", () => {
  assert.equal(pickOptionLabel(src({ labelFor: "Sim" }), 0).text, "Sim");
  assert.equal(pickOptionLabel(src({ aria: "Não" }), 1).text, "Não");
  assert.equal(pickOptionLabel(src({ sibling: "Sim" }), 0).text, "Sim");
  assert.equal(pickOptionLabel(src({ wrapper: "Não" }), 1).text, "Não");
  assert.equal(pickOptionLabel(src({ value: "Yes" }), 0).text, "Yes");
  // a label[for] that merely repeats the question is ignored
  assert.equal(pickOptionLabel(src({ labelFor: "Você tem conhecimento de Power BI?*", sibling: "Sim" }), 0).text, "Sim");
  const u = pickOptionLabel(src({}), 1);
  assert.equal(u.unlabeled, true);
  assert.equal(u.text, "(sem rótulo 2)");
});

t("finalizeStep: labels, selected, unlabeled flag, placeholder, conditional", () => {
  const raw: RawStep = {
    progress: "", section: "", buttons: [], errors: [],
    fields: [
      { label: "Q1*", kind: "radio", required: true, _opts: [src({ labelFor: "Sim", checked: true }), src({ labelFor: "Não" })] },
      { label: "Q2*", kind: "radio", required: true, _opts: [src({}), src({ checked: true })] },
      { label: "Nível", kind: "select", required: true, options: ["Selecionar opção", "Sim"], selected: ["Selecionar opção"] },
      { label: "Se sim para pergunta anterior, qual é o nome completo?", kind: "text", required: true },
    ],
  };
  const s = finalizeStep(raw, 3);
  assert.equal(s.index, 3);
  assert.deepEqual(s.fields[0].options, ["Sim", "Não"]);
  assert.deepEqual(s.fields[0].selected, ["Sim"]);
  assert.equal(s.fields[0].unlabeled_options, undefined);
  assert.deepEqual(s.fields[1].options, ["(sem rótulo 1)", "(sem rótulo 2)"]);
  assert.equal(s.fields[1].unlabeled_options, true);
  assert.deepEqual(s.fields[2].selected, []);
  assert.equal(s.fields[3].conditional, true);
  assert.ok(!("_opts" in s.fields[0]));
});

t("PII masking: e-mail anywhere (select options too), phone, names", () => {
  assert.equal(maskEmail("fulano.detal@example.com"), "fu***@example.com");
  const step: MappedStep = {
    index: 0, progress: "", section: "", buttons: [], errors: [],
    fields: [
      { label: "Email*", kind: "select", required: true, options: ["Selecionar opção", "fulano@example.com"], selected: ["fulano@example.com"], key: "EMAIL" },
      { label: "Phone*", kind: "tel", required: true, prefilled: "11900004321" },
      { label: "First name*", kind: "text", required: true, prefilled: "Fulano", key: "FIRST_NAME" },
      { label: "Last name*", kind: "text", required: true, prefilled: "Detal", key: "LAST_NAME" },
      { label: "Contact", kind: "text", required: false, prefilled: "me@x.org", hint: "Use a@b.com" },
    ],
  };
  const out = JSON.stringify(maskSteps([step]));
  for (const leak of ["fulano@example.com", "11900004321", "Fulano", "Detal", "me@x.org", "a@b.com"]) assert.ok(!out.includes(leak), `leaked ${leak}`);
  const f = maskSteps([step])[0].fields;
  assert.equal(f[1].prefilled, "***4321");
  assert.equal(f[2].prefilled, "F***");
  assert.equal(f[0].options?.[0], "Selecionar opção");
});

t("review step free text: the account's name and phone are masked too (live leak)", () => {
  const contact: MappedStep = {
    index: 0, progress: "", section: "", buttons: [], errors: [],
    fields: [
      { label: "First name*", kind: "text", required: true, prefilled: "Fulano", key: "FIRST_NAME" },
      { label: "Last name*", kind: "text", required: true, prefilled: "Detal", key: "LAST_NAME" },
      { label: "Mobile phone number*", kind: "tel", required: true, prefilled: "11900004321", key: "PHONE_MOBILE" },
    ],
  };
  const review: MappedStep = {
    index: 4, progress: "", section: "Revise sua candidatura", buttons: ["Editar, Fulano"], errors: [], fields: [],
    dialog_text: "Contact info Editar Fulano Detal Data Analytics | SQL First name Fulano Last name Detal Mobile phone number 11900004321 Email address fulano@example.com Dates 2016 - 2022",
  };
  const out = JSON.stringify(maskSteps([contact, review]));
  for (const leak of ["Fulano", "Detal", "11900004321", "fulano@example.com"]) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.match(out, /Mobile phone number \*\*\*4321/);
  assert.match(out, /2016 - 2022/); // dates are not phone numbers
  // a map with only the review step: the bank's own values still mask it
  const alone = JSON.stringify(maskSteps([review], bankSecrets({ profile: { first_name: "Fulano", last_name: "Detal", phone: { national: "(11) 90000-4321" } } })));
  for (const leak of ["Fulano", "Detal", "11900004321"]) assert.ok(!alone.includes(leak), `leaked ${leak} (bank secrets)`);
  assert.ok(alone.includes("Data Analytics")); // the rest of the text stays readable
});

t("long consent labels survive up to 2000 chars", () => {
  const long = "Para tornar nosso processo mais ágil usamos inteligência artificial (IA). ".repeat(25); // ~1,850
  const step: MappedStep = { index: 0, progress: "", section: "", buttons: [], errors: [], fields: [{ label: long, kind: "select", required: true, options: ["Sim, autorizo", "Não, não autorizo"] }] };
  const [c] = clipSteps([step]);
  assert.equal(c.fields[0].label, long);
  const huge = clipSteps([{ ...step, fields: [{ ...step.fields[0], label: "x".repeat(5000) }] }])[0].fields[0].label;
  assert.ok(huge.length < 2100 && huge.includes("truncated"));
});

t("empty-fields form reports a reason", () => {
  assert.match(emptyReason("no_next_button", [], undefined)!, /could not be read/);
  const empty: MappedStep = { index: 0, progress: "", section: "", buttons: ["Fechar", "Continuar"], errors: [], fields: [], dialog_text: "Apply with partner" };
  const r = emptyReason("no_next_button", [empty])!;
  assert.match(r, /No form fields captured/);
  assert.match(r, /Fechar, Continuar/);
  assert.equal(emptyReason("submit_step", [{ ...empty, fields: [{ label: "a", kind: "text", required: false }] }]), undefined);
});

t("no Easy Apply button: the job's top card says why (closed / applied are saved to the cache)", () => {
  assert.match(noEasyApplyError({ closed: true, applied: false }), /^Job closed .*marked closed/);
  assert.match(noEasyApplyError({ closed: false, applied: true }), /^Already applied/);
  assert.match(noEasyApplyError({ closed: false, applied: false }), /^No Easy Apply button/);
  // the mapper really records it (source check: mapper.ts needs a browser)
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", "mapper.ts"), "utf8");
  assert.match(src, /if \(top\.closed \|\| top\.applied\) upsertJob\(\{ id: jobId, closed: top\.closed \? 1 : 0, applied: top\.applied \? 1 : 0 \}\)/);
});

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASS");
