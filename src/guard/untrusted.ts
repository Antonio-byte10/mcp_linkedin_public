/**
 * Third-party text (job descriptions, About sections, company summaries,
 * recruiter questions) is returned to an LLM. Strip invisible/bidi control
 * characters and cap the length; the server's MCP instructions tell the client
 * this text is data, never instructions.
 */
// Invisible or direction-changing code points used to hide or reorder text:
// C0/C1 controls except \t \n \r, soft hyphen, Arabic letter mark, Hangul fillers, Mongolian vowel separator,
// zero-width and bidi marks/embeddings/isolates, line/paragraph separators, word joiner and invisible operators,
// BOM, interlinear annotation marks, and the Unicode Tag block (U+E0000-E007F, "ASCII smuggling").
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

export function clip(s: string | null | undefined, max = 4000): string {
  const t = String(s ?? "").replace(INVISIBLE, "");
  if (t.length <= max) return t;
  // Never cut a surrogate pair in half (would leave a lone surrogate in the JSON).
  const cut = /[\uD800-\uDBFF]/.test(t[max - 1] ?? "") ? max - 1 : max;
  return `${t.slice(0, cut)}… [truncated ${t.length - cut} chars]`;
}

/** Envelope for long third-party text fields. */
export function untrusted(s: string | null | undefined, max = 4000) {
  return { untrusted_text: clip(s, max) };
}

/**
 * clip() every string inside a value (objects and arrays, recursively), keeping its shape.
 * For tool outputs built from scraped fields (names, titles, locations, URLs).
 */
export function clipFields<T>(v: T, max = 300): T {
  if (typeof v === "string") return clip(v, max) as T;
  if (Array.isArray(v)) return v.map((x) => clipFields(x, max)) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipFields(x, max)])) as T;
  }
  return v;
}
