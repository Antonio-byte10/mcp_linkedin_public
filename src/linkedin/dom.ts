/**
 * In-page helpers (passed to page.evaluate, so each must be self-contained).
 *
 * LinkedIn's 2026 UI (search, profiles, company pages, job view, jobs tracker)
 * uses hashed atomic CSS classes, so selectors anchor on entity links
 * (/in/, /company/, /jobs/view/) and on line order of innerText instead.
 */

export type RawCard = { href: string; hrefs: string[]; lines: string[]; buttons: string[]; /** aria-label / title of the entity links ("Ver perfil de X"). */ linkLabels: string[] };

/**
 * Card = ancestor of an entity link whose parent has >= N siblings that also contain such a link.
 * Tries N=4 first (robust on full result pages), then N=2 for pages with only 2-3 results.
 * With a single result, falls back to the highest ancestor holding exactly one distinct entity href.
 */
export function cardsByLink(needle: string): RawCard[] {
  const sel = needle.split("|").map((n) => `a[href*="${n}"]`).join(",");
  const has = (e: Element) => !!e.querySelector(sel);
  const norm = (h: string) => h.split("?")[0].replace(/\/$/, "");
  const scope = document.querySelector("main") ?? document.body;
  const links = [...scope.querySelectorAll<HTMLAnchorElement>(sel)];
  const collect = (min: number) => {
    const found = new Set<Element>();
    for (const a of links) {
      let el: Element = a;
      while (el.parentElement && el.parentElement !== scope.parentElement) {
        if ([...el.parentElement.children].filter(has).length >= min) {
          found.add(el);
          break;
        }
        el = el.parentElement;
      }
    }
    return found;
  };
  let found = collect(4);
  if (!found.size) found = collect(2);
  if (!found.size && links.length) {
    const distinct = (e: Element) => new Set([...e.querySelectorAll<HTMLAnchorElement>(sel)].map((x) => norm(x.href))).size;
    let el: Element = links[0];
    while (el.parentElement && el.parentElement !== scope && distinct(el.parentElement) === 1) el = el.parentElement;
    found = new Set([el]);
  }
  return [...found].map((c) => {
    const hrefs = [...new Set([...c.querySelectorAll<HTMLAnchorElement>(sel)].map((a) => norm(a.href)))];
    return {
      href: hrefs[0] ?? "",
      hrefs,
      lines: (c as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean),
      buttons: [...c.querySelectorAll<HTMLElement>("button, a[role=button]")]
        .map((b) => (b.getAttribute("aria-label") || b.innerText).trim())
        .filter(Boolean),
      // only links to the card's own entity: a mutual connection's profile link names someone else
      linkLabels: [...new Set(
        [...c.querySelectorAll<HTMLAnchorElement>(sel)]
          .filter((a) => norm(a.href) === hrefs[0])
          .map((a) => (a.getAttribute("aria-label") || a.getAttribute("title") || "").trim()),
      )].filter(Boolean),
    };
  });
}

/** innerText lines of <main> (or body). */
export function mainLines(): string[] {
  const m = (document.querySelector("main") ?? document.body) as HTMLElement;
  return m.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Pull "Label\nValue" pairs out of a line list, for the given labels. */
export function pairs(lines: string[], labels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (labels.includes(l) && lines[i + 1] && !labels.includes(lines[i + 1]) && !(l in out)) out[l] = lines[i + 1];
  });
  return out;
}
