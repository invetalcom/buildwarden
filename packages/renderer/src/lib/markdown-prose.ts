// A fence may follow quote markers and list markers on the same line (`> - ```ts`, `1. ~~~`).
const FENCE_OPEN = /^[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** Applies `transform` to the text outside inline code spans (`code`, ``co`de``). */
const mapOutsideInlineCode = (text: string, transform: (text: string) => string): string => {
  let result = "";
  let plain = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`" || text[index - 1] === "\\") {
      plain += text[index++];
      continue;
    }
    let end = index;
    while (text[end] === "`") end++;
    const run = text.slice(index, end);
    // The span closes at the next run of exactly the same length.
    let search = end;
    let close = -1;
    while (search < text.length) {
      const next = text.indexOf(run, search);
      if (next === -1) break;
      let after = next + run.length;
      if (text[next - 1] !== "`" && text[after] !== "`") { close = next; break; }
      while (text[after] === "`") after++;
      search = after;
    }
    if (close === -1) {
      plain += run;
      index = end;
      continue;
    }
    result += transform(plain) + text.slice(index, close + run.length);
    plain = "";
    index = close + run.length;
  }
  return result + transform(plain);
};

/** Removes `depth` blockquote markers; null when the line has fewer (it is outside the quote). */
const stripQuoteMarkers = (line: string, depth: number): string | null => {
  let rest = line;
  for (let level = 0; level < depth; level++) {
    const marker = /^[ \t]{0,3}>[ \t]?/.exec(rest);
    if (!marker) return null;
    rest = rest.slice(marker[0].length);
  }
  return rest;
};

const indentWidth = (text: string) => (/^[ \t]*/.exec(text)?.[0] ?? "").replace(/\t/g, "    ").length;

type Fence = { marker: string; length: number; quoteDepth: number; listIndent: number };

/**
 * A fence opened inside a quote or on a list-marker line belongs to that container, and ends
 * (closed or not) where the container ends: at a line without the quote markers, or at a non-blank
 * line indented less than the list item's content.
 */
const leavesFenceContainer = (line: string, fence: Fence): boolean => {
  const inner = stripQuoteMarkers(line, fence.quoteDepth);
  if (inner === null) return true;
  return fence.listIndent > 0 && inner.trim() !== "" && indentWidth(inner) < fence.listIndent;
};

/**
 * Applies `transform` to Markdown prose only: fenced code blocks (also inside quotes and lists) and
 * inline code spans pass through unchanged. An unclosed fence runs to the end of its container, or
 * of the text, as while streaming.
 */
export const mapMarkdownProse = (markdown: string, transform: (prose: string) => string): string => {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let result = "";
  let prose = "";
  let fence: Fence | null = null;
  const flush = () => {
    if (prose) result += mapOutsideInlineCode(prose, transform);
    prose = "";
  };
  for (const line of lines) {
    if (fence && leavesFenceContainer(line, fence)) fence = null;
    if (fence) {
      result += line;
      const close = new RegExp(`^[ \\t]*(?:>[ \\t]*)*\\${fence.marker}{${fence.length},}[ \\t]*\\r?\\n?$`);
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line.replace(/\r?\n$/, ""));
    // A backtick fence's info string cannot contain backticks (that is inline code instead).
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flush();
      const prefix = line.slice(0, line.indexOf(open[1]));
      const quoteDepth = prefix.split(">").length - 1;
      const afterQuotes = stripQuoteMarkers(prefix, quoteDepth) ?? "";
      const listIndent = /[-*+]|\d[.)]/.test(afterQuotes) ? afterQuotes.replace(/\t/g, "    ").length : 0;
      fence = { marker: open[1][0], length: open[1].length, quoteDepth, listIndent };
      result += line;
      continue;
    }
    prose += line;
  }
  flush();
  return result;
};
