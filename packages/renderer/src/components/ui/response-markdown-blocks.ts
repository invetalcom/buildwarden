/**
 * Splits a response into top-level Markdown blocks that render exactly like the
 * whole text, so a streaming response re-parses only its changed tail.
 */
import { slug } from "github-slugger";

/** Short responses parse in well under a millisecond; keep them on one renderer. */
export const MIN_SPLIT_MARKDOWN_LENGTH = 2_000;

// Footnotes resolve across the whole document.
const FOOTNOTE_SYNTAX = /\[\^/;
// Link reference definitions also resolve document-wide, including those inside
// block quotes or list items and those whose label wraps lines. Every definition
// ends its label with "]:", so any such text outside code keeps the document whole.
const REFERENCE_DEFINITION_END = "]:";
// The media layout groups an image with its neighboring title and description.
const IMAGE_SYNTAX = /!\[|<img\b/i;
// rehype-raw parses raw HTML as one document: an open tag can wrap later blocks,
// and formatting tags are reopened in following paragraphs. Autolinks are not HTML.
const RAW_HTML = /<(?:[a-z][a-z\d-]*(?=[\s/>])|\/[a-z]|!|\?)/i;
// CommonMark URI and email autolinks. A backtick inside one is literal, because
// the autolink starts first; it must not open a code span that hides later HTML.
const AUTOLINK =
  // CommonMark excludes exactly the ASCII controls and space from autolink URIs.
  // eslint-disable-next-line no-control-regex
  /<(?:[a-z][a-z\d+.-]{1,31}:[^<>\x00-\x20\x7f]*|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*)>/iy;

/**
 * Removes the code spans of one line. A backslash escapes the next character,
 * an autolink is kept as text, and a span closes only at a backtick run of the same length. Returns null when
 * a run stays open: a span may then continue on the next line, and pairing
 * line by line could hide raw HTML or a definition that the whole text renders.
 */
const textOutsideCodeSpans = (line: string): string | null => {
  let text = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\\") {
      text += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (line[index] === "<") {
      AUTOLINK.lastIndex = index;
      const autolink = AUTOLINK.exec(line)?.[0];
      if (autolink) {
        text += autolink;
        index += autolink.length;
        continue;
      }
    }
    if (line[index] !== "`") {
      text += line[index];
      index++;
      continue;
    }
    let runEnd = index;
    while (line[runEnd] === "`") runEnd++;
    const length = runEnd - index;
    // Backslashes are literal inside a code span, so the closing search ignores them.
    let search = runEnd;
    let closed = false;
    while (search < line.length) {
      if (line[search] !== "`") {
        search++;
        continue;
      }
      let closeEnd = search;
      while (line[closeEnd] === "`") closeEnd++;
      if (closeEnd - search === length) {
        closed = true;
        index = closeEnd;
        break;
      }
      search = closeEnd;
    }
    if (!closed) return null;
  }
  return text;
};
// A backtick fence's info string cannot contain a backtick ("```a``` is a code span).
// `$$` opens display math (remark-math), which may contain blank lines like a code fence;
// `$$x$$` on one line is inline math, not an opener.
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,}|\${2,}(?![^$\n]*\$))/;
// After a blank line these may continue the previous block: indented content or a list item.
const CONTINUES_PREVIOUS_BLOCK = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const BLANK_LINE = /^[ \t]*$/;

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * rehype-slug numbers repeated heading slugs per document (`example`, `example-1`), so separately
 * rendered blocks would give repeated headings the same id and `#example-1` links would break.
 * Returns whether this heading's approximate slug was seen before; an approximation only ever
 * keeps more responses whole.
 */
const repeatsHeadingSlug = (text: string, seen: Set<string>): boolean => {
  const id = slug(text.trim());
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
};

const closesFence = (line: string, fence: string): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
};

/**
 * Returns the blocks in order, each with its trailing blank lines, so joining
 * them reproduces the input. Returns null when the text must render as a whole.
 */
export const splitResponseMarkdownBlocks = (content: string): string[] | null => {
  if (content.length < MIN_SPLIT_MARKDOWN_LENGTH) return null;
  if (content.startsWith("﻿") || content.includes("\r")) return null;
  if (FOOTNOTE_SYNTAX.test(content) || IMAGE_SYNTAX.test(content)) return null;

  const blocks: string[] = [];
  let blockStart = 0;
  let blockHasContent = false;
  let lineStart = 0;
  let fence: string | null = null;
  let afterBlankLine = false;
  const headingSlugs = new Set<string>();
  // The previous prose line, which a setext underline turns into a heading.
  let previousLine: string | null = null;
  while (lineStart < content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      previousLine = null;
    } else if (BLANK_LINE.test(line)) {
      afterBlankLine = true;
      previousLine = null;
    } else {
      const openedFence = FENCE_OPEN.exec(line)?.[1] ?? null;
      // A fence line's info string is neither HTML nor a code span delimiter.
      if (!openedFence) {
        const text = textOutsideCodeSpans(line);
        if (text === null || RAW_HTML.test(text) || text.includes(REFERENCE_DEFINITION_END)) return null;
        const atx = ATX_HEADING.exec(line);
        const headingText = atx ? atx[1] ?? "" : previousLine !== null && SETEXT_UNDERLINE.test(line) ? previousLine : null;
        if (headingText !== null && repeatsHeadingSlug(headingText, headingSlugs)) return null;
      }
      previousLine = openedFence ? null : line;
      if (afterBlankLine && blockHasContent && !CONTINUES_PREVIOUS_BLOCK.test(line)) {
        blocks.push(content.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      blockHasContent = true;
      afterBlankLine = false;
      fence = openedFence;
    }
    lineStart = lineEnd + 1;
  }
  blocks.push(content.slice(blockStart));
  return blocks.length > 1 ? blocks : null;
};
