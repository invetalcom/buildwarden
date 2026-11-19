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

/** A quote, or a list item whose content starts at `contentColumn`, outermost first. */
type Container = { kind: "quote" } | { kind: "list"; contentColumn: number };

type Fence = { marker: string; length: number; containers: Container[] };

const QUOTE_MARKER = /^[ \t]{0,3}>/;
const LIST_MARKER = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** The column after `text`, starting at `column`. Tabs advance to the next multiple of 4, as in CommonMark. */
const advance = (text: string, column: number) => {
  let next = column;
  for (const char of text) next += char === "\t" ? 4 - (next % 4) : 1;
  return next;
};

/** Removes `columns` columns of leading whitespace; null when the line has less. */
const consumeIndent = (text: string, column: number, columns: number): { rest: string; column: number } | null => {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  let index = 0;
  let consumed = 0;
  while (consumed < columns) {
    if (index >= indent.length) return null;
    consumed = advance(indent.slice(0, ++index), column) - column;
  }
  return { rest: " ".repeat(consumed - columns) + text.slice(index), column: column + columns };
};

/**
 * Removes a quote marker and the one column of whitespace that may follow it (a tab there counts as
 * one column; the rest of it stays as indentation). Null when the text has no quote marker.
 */
const consumeQuoteMarker = (text: string, column: number): { rest: string; column: number } | null => {
  const marker = QUOTE_MARKER.exec(text);
  if (!marker) return null;
  const after = { rest: text.slice(marker[0].length), column: advance(marker[0], column) };
  return /^[ \t]/.test(after.rest) ? consumeIndent(after.rest, after.column, 1) : after;
};

/** The quotes and list items a fence opener sits in, from the text before its fence marker. */
const parseContainers = (prefix: string): Container[] => {
  const containers: Container[] = [];
  let position = { rest: prefix, column: 0 };
  for (;;) {
    const quote = consumeQuoteMarker(position.rest, position.column);
    if (quote) {
      containers.push({ kind: "quote" });
      position = quote;
      continue;
    }
    const list = LIST_MARKER.exec(position.rest);
    if (!list) return containers;
    position = { rest: position.rest.slice(list[0].length), column: advance(list[0], position.column) };
    containers.push({ kind: "list", contentColumn: position.column });
  }
};

/**
 * Whether a line continues every container of a fence, checked outermost first: a quote needs its
 * marker, and a list item needs its content indentation unless the rest of the line is blank.
 */
const continuesContainers = (line: string, containers: Container[]): boolean => {
  let rest = line.replace(/\r?\n$/, "");
  let column = 0;
  for (const container of containers) {
    if (container.kind === "quote") {
      const inside = consumeQuoteMarker(rest, column);
      if (!inside) return false;
      ({ rest, column } = inside);
      continue;
    }
    if (!rest.trim()) continue;
    const inside = consumeIndent(rest, column, container.contentColumn - column);
    if (!inside) return false;
    ({ rest, column } = inside);
  }
  return true;
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
    // A fence in a quote or list item ends (closed or not) where its container ends.
    if (fence && !continuesContainers(line, fence.containers)) fence = null;
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
      const containers = parseContainers(line.slice(0, line.indexOf(open[1])));
      fence = { marker: open[1][0], length: open[1].length, containers };
      result += line;
      continue;
    }
    prose += line;
  }
  flush();
  return result;
};
