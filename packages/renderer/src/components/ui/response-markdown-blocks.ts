/**
 * Splits a response into top-level Markdown blocks that render exactly like the
 * whole text, so a streaming response re-parses only its changed tail.
 */

/** Short responses parse in well under a millisecond; keep them on one renderer. */
export const MIN_SPLIT_MARKDOWN_LENGTH = 2_000;

// Link reference definitions and footnotes resolve across the whole document.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}\[[^\]\n]+\]:|\[\^/m;
// The media layout groups an image with its neighboring title and description.
const IMAGE_SYNTAX = /!\[|<img\b/i;
// rehype-raw parses raw HTML as one document: an open tag can wrap later blocks,
// and formatting tags are reopened in following paragraphs. Autolinks are not HTML.
const RAW_HTML = /<(?:[a-z][a-z\d-]*(?=[\s/>])|\/[a-z]|!|\?)/i;
const INLINE_CODE = /(`+)[^`]*?\1/g;
// A backtick fence's info string cannot contain a backtick ("```a``` is a code span).
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
// After a blank line these may continue the previous block: indented content or a list item.
const CONTINUES_PREVIOUS_BLOCK = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const BLANK_LINE = /^[ \t]*$/;

const closesFence = (line: string, fence: string): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
};

/**
 * Returns the blocks in order, each with its trailing blank lines, so joining
 * them reproduces the input. Returns null when the text must render as a whole.
 */
export const splitResponseMarkdownBlocks = (content: string): string[] | null => {
  if (content.length < MIN_SPLIT_MARKDOWN_LENGTH) return null;
  if (content.startsWith("﻿") || content.includes("\r")) return null;
  if (DOCUMENT_WIDE_SYNTAX.test(content) || IMAGE_SYNTAX.test(content)) return null;

  const blocks: string[] = [];
  let blockStart = 0;
  let blockHasContent = false;
  let lineStart = 0;
  let fence: string | null = null;
  let afterBlankLine = false;
  while (lineStart < content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (BLANK_LINE.test(line)) {
      afterBlankLine = true;
    } else {
      // Code spans that wrap lines are not removed here; that can only prevent a split.
      if (RAW_HTML.test(line.replace(INLINE_CODE, ""))) return null;
      if (afterBlankLine && blockHasContent && !CONTINUES_PREVIOUS_BLOCK.test(line)) {
        blocks.push(content.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      blockHasContent = true;
      afterBlankLine = false;
      fence = FENCE_OPEN.exec(line)?.[1] ?? null;
    }
    lineStart = lineEnd + 1;
  }
  blocks.push(content.slice(blockStart));
  return blocks.length > 1 ? blocks : null;
};
