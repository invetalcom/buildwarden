/**
 * Models write math with three delimiter styles. Markdown would eat the backslashes of `\(…\)` and
 * `\[…\]` (they are escapes) and leave `$…$` alone. This rewrites all of them to the `$$` form that
 * remark-math parses with single-dollar math turned off, so prices such as "$5 and $10" stay text.
 * Apply it to prose only (see `mapMarkdownProse`).
 */

// Something only formulas contain; keeps escaped brackets such as `\[TODO\]` as text.
const LOOKS_LIKE_MATH = /[\\^_=+\-*/<>|]|\d/;
// Markdown escapes LaTeX does not use. Escaped literal text, such as a quoted citation that reads
// `[text]\(https\://example\.com\)`, contains them; a formula does not.
const ESCAPED_TEXT = /\\[.:()[\]*`<>~+\-'"/?@=^]/;
// A lone variable such as `\(x\)` or `\[n'\]`.
const SINGLE_SYMBOL = /^\s*[A-Za-z]'*\s*$/;

/**
 * Whether a `\(…\)` / `\[…\]` body is a formula. Single symbols count unless the surrounding prose is
 * itself escaped literal text (where `option \(a\)` is just "option (a)").
 */
const formulaTest = (prose: string) => {
  const literalProse = ESCAPED_TEXT.test(prose.replace(/\\[()[\]]/g, ""));
  return (body: string) => !/\n[ \t]*\n/.test(body) && !ESCAPED_TEXT.test(body)
    && (LOOKS_LIKE_MATH.test(body) || (!literalProse && SINGLE_SYMBOL.test(body)));
};

// Keeps the indentation so display math inside a list item stays in that item.
const display = (body: string, indent: string) =>
  `${indent}$$\n${body.trim().split("\n").map((line) => `${indent}${line.trim()}`).join("\n")}\n${indent}$$`;
const inline = (body: string) => `$$${body.trim()}$$`;

/** `$x$` qualifies as math under Pandoc's rules: no space inside the dollars, no digit right after. */
const singleDollarMath = (text: string): string => {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      result += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char !== "$") {
      result += char;
      index++;
      continue;
    }
    // Existing `$$…$$` math passes through unchanged.
    if (text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      const end = close === -1 ? text.length : close + 2;
      result += text.slice(index, end);
      index = end;
      continue;
    }
    const opensMath = text[index + 1] !== undefined && !/\s/.test(text[index + 1]);
    let close = -1;
    if (opensMath) {
      for (let search = index + 1; search < text.length; search++) {
        if (text[search] === "\\") { search++; continue; }
        if (text[search] === "\n" && text[search + 1] === "\n") break;
        if (text[search] !== "$") continue;
        if (text[search + 1] === "$") break;
        if (!/\s/.test(text[search - 1]) && !/\d/.test(text[search + 1] ?? "")) close = search;
        break;
      }
    }
    if (close === -1) {
      result += char;
      index++;
      continue;
    }
    result += inline(text.slice(index + 1, close));
    index = close + 1;
  }
  return result;
};

type Masker = (text: string, mask: (url: string) => string) => string;

/**
 * Masks `](destination` of inline links and images: a `<…>` destination, or one that runs to
 * whitespace or the link's closing `)`, with balanced and backslash-escaped parentheses inside.
 */
const maskLinkDestinations: Masker = (text, mask) => {
  let result = "";
  let copied = 0;
  for (let start = text.indexOf("]("); start !== -1; start = text.indexOf("](", start + 2)) {
    if (start < copied) continue;
    let end = start + 2;
    while (text[end] === " " || text[end] === "\t") end++;
    const angleEnd = text[end] === "<" ? text.indexOf(">", end) : -1;
    if (angleEnd !== -1 && !text.slice(end, angleEnd).includes("\n")) {
      end = angleEnd + 1;
    } else {
      for (let depth = 0; end < text.length && !/\s/.test(text[end]); end++) {
        if (text[end] === "\\") { end++; continue; }
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && depth-- === 0) break;
      }
      end = Math.min(end, text.length);
    }
    result += text.slice(copied, start) + mask(text.slice(start, end));
    copied = end;
  }
  return result + text.slice(copied);
};

const maskPattern = (pattern: RegExp): Masker => (text, mask) => text.replace(pattern, mask);

// URLs are not prose: link and image destinations, reference definitions, <autolinks> and bare URLs.
const URL_MASKERS: Masker[] = [
  maskLinkDestinations,
  maskPattern(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+/gm),
  maskPattern(/<[a-z][a-z\d+.-]{1,31}:[^\s<>]*>/gi),
  maskPattern(/\b(?:https?:\/\/|www\.)[^\s<>]*/gi),
];
/**
 * Two private-use characters that do not occur in the text, so a placeholder can never come from
 * the input itself; null when the text uses at least one of every pair.
 */
const placeholderDelimiters = (text: string): [string, string] | null => {
  for (let code = 0xe000; code < 0xf8ff; code += 2) {
    const start = String.fromCharCode(code);
    const end = String.fromCharCode(code + 1);
    if (!text.includes(start) && !text.includes(end)) return [start, end];
  }
  return null;
};

/**
 * Runs `transform` with every URL replaced by a placeholder, then puts the URLs back unchanged.
 * Each stored URL is the original text (an earlier placeholder inside it is expanded when it is
 * masked), so restoring is one pass whose replacements are never scanned again: input cannot make
 * it repeat or grow.
 */
const outsideUrls = (prose: string, transform: (text: string) => string): string => {
  const delimiters = placeholderDelimiters(prose);
  // Only text full of private-use characters gets here; convert it without URL protection.
  if (!delimiters) return transform(prose);
  const [start, end] = delimiters;
  const placeholder = new RegExp(`${start}(\\d+)${end}`, "g");
  const urls: string[] = [];
  const restore = (text: string) => text.replace(placeholder, (match, index: string) => urls[Number(index)] ?? match);
  let masked = prose;
  for (const maskUrls of URL_MASKERS) {
    masked = maskUrls(masked, (url) => `${start}${String(urls.push(restore(url)) - 1)}${end}`);
  }
  return urls.length ? restore(transform(masked)) : transform(prose);
};

const convertMathDelimiters = (prose: string): string => {
  const isFormula = formulaTest(prose);
  const bracketed = prose
    // On a line of its own, \[ … \] (which may span lines) or $$ … $$ is display math.
    .replace(/(^|\n)([ \t]*)\\\[([\s\S]+?)\\\][ \t]*(?=\r?\n|$)/g, (match, start: string, indent: string, body: string) =>
      isFormula(body) ? `${start}${display(body, indent)}` : match)
    .replace(/(^|\n)([ \t]*)\$\$([^$\n]+?)\$\$[ \t]*(?=\r?\n|$)/g, (_match, start: string, indent: string, body: string) =>
      `${start}${display(body, indent)}`)
    // `\\(` is an escaped backslash followed by a parenthesis, not a delimiter.
    .replace(/(?<!\\)\\\[([\s\S]+?)\\\]/g, (match, body: string) => (isFormula(body) ? inline(body) : match))
    .replace(/(?<!\\)\\\(([\s\S]+?)\\\)/g, (match, body: string) => (isFormula(body) ? inline(body) : match));
  return singleDollarMath(bracketed);
};

export const normalizeMathDelimiters = (prose: string): string => {
  if (!/[$\\]/.test(prose)) return prose;
  return outsideUrls(prose, convertMathDelimiters);
};
