import { describe, expect, it } from "vitest";
import {
  buildDiffCommentIndex,
  findCommentsForDiffTargets,
  type DiffLineCommentTarget,
  type DiffPreviewManualComment,
} from "./git-diff-preview-comment-index";

const makeTarget = (overrides: Partial<DiffLineCommentTarget> = {}): DiffLineCommentTarget => ({
  oldPath: "Backend/src/App.ts",
  newPath: "Backend/src/App.ts",
  side: "new",
  oldLineNumber: null,
  newLineNumber: 20,
  changeType: "insert",
  displayPath: "Backend/src/App.ts",
  changeKey: "I20",
  lineLabel: "Backend/src/App.ts:20 new",
  ...overrides,
});

const makeComment = (id: string, overrides: Partial<DiffPreviewManualComment> = {}): DiffPreviewManualComment => ({
  id,
  oldPath: "Backend/src/App.ts",
  newPath: "Backend/src/App.ts",
  side: "new",
  oldLineNumber: null,
  newLineNumber: 20,
  changeType: "insert",
  body: id,
  ...overrides,
});

describe("git diff preview comment indexing", () => {
  it("returns the same exact and suffix path matches without scanning every comment", () => {
    const target = makeTarget();
    const comments = [
      makeComment("exact"),
      makeComment("suffix", { oldPath: "src/App.ts", newPath: "src/App.ts" }),
      makeComment("wrong-line", { newLineNumber: 21 }),
      makeComment("wrong-path", { oldPath: "Frontend/src/App.ts", newPath: "Frontend/src/App.ts" }),
    ];

    const matches = findCommentsForDiffTargets(buildDiffCommentIndex(comments), [target]);

    expect(matches.map((comment) => comment.id)).toEqual(["exact", "suffix"]);
  });

  it("deduplicates comments that match both the exact key and line index", () => {
    const target = makeTarget();
    const comment = makeComment("one-comment");

    const matches = findCommentsForDiffTargets(buildDiffCommentIndex([comment]), [target]);

    expect(matches).toEqual([comment]);
  });
});
