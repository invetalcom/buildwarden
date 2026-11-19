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

/**
 * Applies `transform` to Markdown prose only: fenced code blocks (also inside quotes and lists) and
 * inline code spans pass through unchanged. An unclosed fence runs to the end, as while streaming.
 */
export const mapMarkdownProse = (markdown: string, transform: (prose: string) => string): string => {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let result = "";
  let prose = "";
  let fence: { marker: string; length: number } | null = null;
  const flush = () => {
    if (prose) result += mapOutsideInlineCode(prose, transform);
    prose = "";
  };
  for (const line of lines) {
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
      fence = { marker: open[1][0], length: open[1].length };
      result += line;
      continue;
    }
    prose += line;
  }
  flush();
  return result;
};
