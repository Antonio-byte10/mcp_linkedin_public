import type { OptSrc, RawField } from "./mapperPure.js";

/**
 * The one in-page reader of the Easy Apply dialog, shared by the read-only mapper (map_easy_apply_form)
 * and the form filler (apply_execute). Before, each had its own copy and they drifted; now every shared
 * rule (field order, labels, option sources, required, hints, semantic keys) lives here once.
 *
 * Differences between the callers are one explicit option, not a fork:
 *  - fill=false (mapper): read-only; no DOM stamps; unlabeled controls fall back to surrounding text;
 *    selects with >40 options are truncated for the output; reports file-slot hints.
 *  - fill=true (filler): stamps data-mcp-ff / data-mcp-ffo so controls can be addressed later; only the
 *    control's own label/legend (a neighbour's question must never label an answer); full select options;
 *    checkbox state as selected, never as a prefilled value.
 * PII masking is not here: the mapper masks its output in Node (maskSteps); the filler needs real values.
 */
export type DialogReadOpts = { fill: boolean };
export type DialogReadField = RawField & { ref?: number };
export type DialogRead = {
  fields: DialogReadField[];
  resumeSection: boolean;
  progress: string;
  section: string;
  buttons: string[];
  errors: string[];
  dialog_text?: string;
};

/** Runs in the page via page.evaluate: must stay self-contained (no module-scope references). */
export function readEasyApplyDialog(arg: { titleRe: string; opts: DialogReadOpts }): DialogRead | null {
  const { titleRe, opts } = arg;
  const fill = opts.fill;
  const tre = new RegExp(titleRe, "i");
  const root =
    [...document.querySelectorAll<HTMLElement>("dialog[open], [role=dialog]")].find((d) => tre.test(d.querySelector("h2")?.textContent?.trim() ?? "")) ?? null;
  if (!root) return null;
  if (fill) {
    root.querySelectorAll("[data-mcp-ff]").forEach((e) => e.removeAttribute("data-mcp-ff"));
    root.querySelectorAll("[data-mcp-ffo]").forEach((e) => e.removeAttribute("data-mcp-ffo"));
  }
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const byId = (id: string | null) => (id ? root.querySelector(`[id="${CSS.escape(id)}"]`) ?? document.getElementById(id) : null);
  const labelOf = (el: Element): string => {
    const id = el.getAttribute("id");
    const lab = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    if (lab) return clean(lab.textContent);
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    const lb = el.getAttribute("aria-labelledby");
    if (lb) return clean(lb.split(" ").map((x) => byId(x)?.textContent).join(" "));
    return "";
  };
  /** Text that precedes a group inside its nearest ancestors (question text for unlabeled groups). */
  const precedingText = (el: Element): string => {
    let cur: Element | null = el;
    for (let up = 0; up < 5 && cur && cur !== root; up++) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const t = clean((sib as HTMLElement).innerText);
        if (t && !sib.querySelector("input,select,textarea")) return t;
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  };
  /**
   * Raw text sources for one radio/checkbox option; the label is chosen in Node (pickOptionLabel), never "on".
   * Only wrappers that hold this single input count, so a group's whole text is never taken for one option.
   */
  const optionSrc = (i: HTMLInputElement, groupLabel: string): OptSrc => {
    const lab = i.id ? root.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null;
    const lb = i.getAttribute("aria-labelledby");
    const aria = clean(i.getAttribute("aria-label")) || (lb ? clean(lb.split(" ").map((x) => byId(x)?.textContent).join(" ")) : "");
    const near = (e: Element | null) => (e && !e.querySelector("input,select,textarea") ? clean((e as HTMLElement).innerText) : "");
    let wrapper = "";
    let el: Element | null = i.closest("[role=radio], [role=checkbox]") ?? i.parentElement;
    for (let up = 0; up < 4 && el && el !== root; up++) {
      if (el.querySelectorAll("input[type=radio], input[type=checkbox]").length > 1) break;
      const t = clean((el as HTMLElement).innerText);
      if (t) { wrapper = t; break; }
      el = el.parentElement;
    }
    return {
      labelFor: lab ? clean(lab.textContent) : "",
      aria,
      sibling: near(i.nextElementSibling) || near(i.previousElementSibling),
      wrapper,
      value: clean(i.value),
      checked: i.checked || !!i.closest("[aria-checked=true]"),
      groupLabel,
    };
  };
  /** Semantic key LinkedIn embeds in the field wrapper, e.g. FIRST_NAME, PHONE_MOBILE, or "custom" for recruiter questions. */
  const semanticKey = (el: Element): string | undefined => {
    const k = el.closest("[componentkey^=easyApplyFieldFocus]")?.getAttribute("componentkey") ?? "";
    const m = k.match(/::([A-Z_]+)::/);
    if (m) return m[1];
    if (/validation_p\d/.test(k)) return "custom";
    if (el.closest("[componentkey=easyApplyUploadedResumeRef]")) return "RESUME";
    return undefined;
  };
  // Text nodes joined with spaces: the counter "0/20" and its screen-reader twin "0 de 20 caracteres" sit side by
  // side, and textContent would glue them into "0/200 de 20 caracteres".
  const spacedText = (e: Element | null) => {
    if (!e) return "";
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let t = w.nextNode(); t; t = w.nextNode()) parts.push(t.textContent ?? "");
    return parts.join(" ");
  };
  const hintOf = (el: Element) =>
    clean((el.getAttribute("aria-describedby") ?? "").split(" ").map((x) => spacedText(byId(x))).join(" ")) || undefined;
  const isRequired = (el: Element, label: string) =>
    (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label);

  const fields: DialogReadField[] = [];
  const done = new Set<Element>();
  let n = 0;

  // Grouped choices: fieldset / radiogroup / group of checkboxes.
  root.querySelectorAll("fieldset, [role=radiogroup], [role=group]").forEach((g) => {
    const inputs = [...g.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]")].filter((i) => !done.has(i));
    if (!inputs.length) return;
    inputs.forEach((i) => done.add(i));
    const radio = inputs[0].type === "radio";
    const legend = clean(g.querySelector("legend")?.textContent);
    const label = legend || (g.getAttribute("aria-labelledby") ? labelOf(g) : "") || clean(g.getAttribute("aria-label")) || precedingText(g);
    let ref: number | undefined;
    if (fill) {
      const r = n++;
      ref = r;
      g.setAttribute("data-mcp-ff", String(r));
      inputs.forEach((i, j) => i.setAttribute("data-mcp-ffo", `${r}:${j}`));
    }
    fields.push({
      ref,
      label,
      kind: radio ? "radio" : inputs.length > 1 ? "checkbox_group" : "checkbox",
      required: !!g.querySelector("[required],[aria-required=true]") || g.getAttribute("aria-required") === "true" || /\*\s*$/.test(label),
      _opts: inputs.map((i) => optionSrc(i, label)),
      hint: hintOf(g),
      key: semanticKey(g),
    });
  });

  root.querySelectorAll<HTMLElement>("input, select, textarea").forEach((el) => {
    if (done.has(el)) return;
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    if (["hidden", "submit", "button", "search"].includes(type)) return;
    // Filler: only the control's own label / aria / enclosing legend; text found near it may be the neighbour's
    // question and an answer must never be typed under someone else's label (unlabeled => unanswered).
    // Mapper: an unlabeled checkbox next to text (e.g. "Siga a empresa X...") uses the surrounding text.
    const fillLabel = labelOf(el) || clean(el.closest("fieldset")?.querySelector("legend")?.textContent);
    const label = fill
      ? fillLabel
      : labelOf(el) || precedingText(el) || clean((el.closest("div")?.parentElement as HTMLElement | null)?.innerText).slice(0, 200);
    let kind: DialogReadField["kind"] = "unknown";
    let options: string[] | undefined;
    let selected: string[] | undefined;
    if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      kind = "select";
      options = [...s.options].map((o) => clean(o.textContent)).filter(Boolean);
      selected = s.selectedIndex >= 0 && clean(s.options[s.selectedIndex]?.textContent) ? [clean(s.options[s.selectedIndex].textContent)] : [];
      // Truncation is output-only: the filler needs every option to match an answer.
      if (!fill && options.length > 40) options = [...options.slice(0, 15), `… (${options.length} options total)`];
    } else if (el.tagName === "TEXTAREA") kind = "textarea";
    else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") || el.getAttribute("aria-haspopup") === "listbox") kind = "typeahead";
    else if (type === "checkbox") kind = "checkbox";
    else if (type === "radio") kind = "radio";
    else if (type === "file") kind = "file";
    else if (["text", "number", "email", "tel", "url", "date"].includes(type)) kind = type as DialogReadField["kind"];
    if (fill && kind === "checkbox") selected = input.checked ? ["checked"] : [];
    const hint = hintOf(el);
    // Hint reads "7/100 7 de 100 caracteres": take N from "de N caracteres" / "of N characters".
    const maxFromHint = hint?.match(/(?:de|of)\s*(\d+)\s*(?:caracteres|characters)/i);
    let ref: number | undefined;
    if (fill) {
      ref = n++;
      el.setAttribute("data-mcp-ff", String(ref));
    }
    fields.push({
      ref,
      label,
      kind,
      required: isRequired(el, label),
      options,
      selected,
      // The filler reports a checkbox's state in `selected`; the mapper keeps its historical rule (only selects excluded).
      prefilled: kind !== "select" && !(fill && kind === "checkbox") && input.value ? input.value : undefined,
      placeholder: input.placeholder || undefined,
      hint,
      max_length: input.maxLength > 0 ? input.maxLength : maxFromHint ? Number(maxFromHint[1]) : undefined,
      id: el.id || undefined,
      key: semanticKey(el),
    });
  });

  // Upload slots have no <input type=file> until clicked: a "Carregar" button with a caption (cannot be filled).
  root.querySelectorAll<HTMLElement>("button").forEach((b) => {
    if (!/^(carregar|upload)/i.test(clean(b.innerText))) return;
    const box = b.parentElement;
    const caption = clean(box?.querySelector("p")?.textContent) || precedingText(b);
    let ref: number | undefined;
    if (fill) {
      ref = n++;
      b.setAttribute("data-mcp-ff", String(ref));
    }
    fields.push({
      ref,
      label: caption || clean(b.innerText),
      kind: "file",
      required: /\*/.test(caption),
      hint: fill ? undefined : clean(box?.innerText).replace(clean(b.innerText), "").trim() || undefined,
    });
  });
  // A resume section the reader may not see as a field (a card or div[role=radio] without an <input>).
  const resumeSection =
    !!root.querySelector("[componentkey=easyApplyUploadedResumeRef]") ||
    [...root.querySelectorAll("h3, legend, label, [role=radio]")].some((e) => /^(curr[ií]culo|resume)\b/i.test(clean(e.textContent)) || (e.getAttribute("role") === "radio" && /\.(pdf|docx?)\b/i.test(clean(e.textContent))));

  const txt = root.innerText;
  const progress = txt.match(/\d+\s*de\s*\d+\s*páginas?|\d+\s*of\s*\d+|\d+%/i)?.[0] ?? "";
  const section = clean(root.querySelector("[data-testid=lazy-column] p, h3")?.textContent);
  const buttons = [...root.querySelectorAll<HTMLElement>("button")].map((b) => clean(b.innerText || b.getAttribute("aria-label"))).filter(Boolean);
  const errors = [...root.querySelectorAll<HTMLElement>("[role=alert], [id^=error-message], .artdeco-inline-feedback--error")].map((e) => clean(e.innerText)).filter(Boolean);
  const dialog_text = fields.length ? undefined : clean(txt).slice(0, 600);
  return { fields, resumeSection, progress, section, buttons, errors, dialog_text };
}
