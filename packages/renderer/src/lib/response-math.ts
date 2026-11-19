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
const isFormula = (body: string) => LOOKS_LIKE_MATH.test(body) && !ESCAPED_TEXT.test(body) && !/\n[ \t]*\n/.test(body);

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

// URLs are not prose: link and image destinations, reference definitions, <autolinks> and bare URLs.
const URL_PATTERNS = [
  /\]\([ \t]*(?:<[^>\n]*>|[^\s)]*)/g,
  /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+/gm,
  /<[a-z][a-z\d+.-]{1,31}:[^\s<>]*>/gi,
  /\b(?:https?:\/\/|www\.)[^\s<>]*/gi,
];
// Private-use characters cannot appear in a placeholder's surroundings by accident.
const PLACEHOLDER_START = String.fromCharCode(0xe000);
const PLACEHOLDER_END = String.fromCharCode(0xe001);

/** Runs `transform` with every URL replaced by a placeholder, then puts the URLs back unchanged. */
const outsideUrls = (prose: string, transform: (text: string) => string): string => {
  const urls: string[] = [];
  let masked = prose;
  for (const pattern of URL_PATTERNS) {
    masked = masked.replace(pattern, (url) => `${PLACEHOLDER_START}${String(urls.push(url) - 1)}${PLACEHOLDER_END}`);
  }
  if (!urls.length) return transform(prose);
  const placeholder = new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, "g");
  // A later pattern can capture an earlier placeholder, so restore until nothing changes.
  let result = transform(masked);
  for (let previous = ""; previous !== result;) {
    previous = result;
    result = result.replace(placeholder, (_match, index: string) => urls[Number(index)] ?? "");
  }
  return result;
};

const convertMathDelimiters = (prose: string): string => {
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
