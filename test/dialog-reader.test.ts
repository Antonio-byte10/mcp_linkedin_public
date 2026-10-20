// The mapper and the filler must read the Easy Apply dialog with the same in-page function (no drifting copies).
// Source-level checks: the reader runs inside the page, so it cannot be called here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const readSource = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", "linkedin", name), "utf8");

test("mapper (read-only) and formfill (fill mode) both run the shared reader from dialog.ts", () => {
  const mapper = readSource("mapper.ts");
  const formfill = readSource("formfill.ts");
  for (const src of [mapper, formfill]) assert.match(src, /import \{ readEasyApplyDialog \} from "\.\/dialog\.js";/);
  assert.match(mapper, /page\.evaluate\(readEasyApplyDialog, \{[^}]*opts: \{ fill: false \}/);
  assert.match(formfill, /page\.evaluate\(readEasyApplyDialog, \{[^}]*opts: \{ fill: true \}/);
});

test("neither caller keeps its own copy of the field walk", () => {
  for (const name of ["mapper.ts", "formfill.ts"]) {
    // mapper.ts may query controls only inside mapPage (the generic map_page dump), never for the dialog
    const src = readSource(name).split("export async function mapPage")[0];
    assert.doesNotMatch(src, /querySelectorAll/, name);
    assert.doesNotMatch(src, /function readEasyApplyDialog/, name);
  }
  assert.match(readSource("mapper.ts"), /export async function mapPage/, "the split above must find mapPage");
  assert.doesNotMatch(readSource("formfill.ts"), /querySelectorAll/);
  assert.match(readSource("dialog.ts"), /export function readEasyApplyDialog/);
});
