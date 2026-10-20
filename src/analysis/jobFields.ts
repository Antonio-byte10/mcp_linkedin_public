/**
 * Pure parsers for two job-sheet columns, read from the job description (third-party text, so the
 * output is only a number or a short normalised string). PT-BR and EN. No I/O.
 */

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// "3+ anos", "2 a 4 anos", "5 years", "3-5 yrs"; the lower bound of a range is the requirement.
const YEARS_RE = /(\d{1,2})(?:\s*(?:-|–|a|to|ou|or)\s*(\d{1,2}))?\s*\+?\s*(?:anos?|years?|yrs?)\b/g;
// An "N anos" is a requirement only near experience wording: "20 anos no mercado" / "5 years old" are not.
const EXPERIENCE_NEAR = /experienc|minimo|pelo menos|no minimo|at least|minimum|min\.|\d\s*\+/;

/** Years of experience asked for (largest requirement found, 1..40), or null when the text names none. */
export function parseYearsRequired(text: string | null | undefined): number | null {
  const t = fold(String(text ?? "").slice(0, 20000));
  let best: number | null = null;
  for (const m of t.matchAll(YEARS_RE)) {
    const n = Number(m[1]);
    if (!(n >= 1 && n <= 40)) continue;
    const at = m.index ?? 0;
    const near = t.slice(Math.max(0, at - 40), at + m[0].length + 40);
    if (!EXPERIENCE_NEAR.test(near) || /anos? de idade|years? old/.test(near)) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

const CUR_RE = String.raw`(R\$|US\$|U\$S?|\$|€|£)`;
const NUM_RE = String.raw`(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const SUF_RE = String.raw`(?:\s*(k|mil)\b)?`;
const SALARY_RE = new RegExp(
  String.raw`(?:\b(ate|up to)\s+)?${CUR_RE}\s*${NUM_RE}${SUF_RE}` +
    String.raw`(?:\s*(?:-|–|—|a|to|and|e)\s*(?:${CUR_RE}\s*)?${NUM_RE}${SUF_RE})?`,
  "i",
);

/** "8.000,00" / "90,000.50" -> 8000 / 90000; "6,5" with k/mil -> 6500. */
function amount(raw: string, suffix: string | undefined): number {
  if (suffix) return Math.round(parseFloat(raw.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".")) * 1000);
  return Number(raw.replace(/[.,]\d{1,2}$/, "").replace(/[.,]/g, ""));
}
const sym = (c: string) => (/^R\$$/i.test(c) ? "R$" : "$" === c || /^u/i.test(c) ? "US$" : c);
const fmt = (c: string, n: number) => `${sym(c)} ${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

/**
 * Salary range as short text ("R$ 5.000 - R$ 7.000", "R$ 8.000", "até R$ 6.000"), or "" when the
 * text shows no currency amount. A currency symbol is required, so "5 anos" or a bare 5000 never match.
 */
export function parseSalaryRange(text: string | null | undefined): string {
  const t = String(text ?? "").slice(0, 20000);
  const m = SALARY_RE.exec(fold(t).replace(/r\$/g, "R$"));
  if (!m) return "";
  const [, upto, cur1, n1, s1, cur2, n2, s2] = m;
  let a = amount(n1, s1);
  const hi = n2 ? amount(n2, s2 ?? (a < 1000 && s1 ? s1 : undefined)) : null;
  // "$90-120k": the single suffix at the end applies to both ends.
  if (hi !== null && !s1 && s2 && a < 1000) a *= 1000;
  if (a <= 0 || (hi !== null && hi <= 0)) return "";
  if (hi !== null && hi >= a) return `${fmt(cur1, a)} - ${fmt(cur2 ?? cur1, hi)}`;
  return `${upto ? "até " : ""}${fmt(cur1, a)}`;
}
