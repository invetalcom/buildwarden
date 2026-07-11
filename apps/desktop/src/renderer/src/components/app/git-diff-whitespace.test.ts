import { describe, expect, it } from "vitest";
import { parseGitDiffFiles } from "./git-diff-utils";
import { filterWhitespaceOnlyChanges } from "./git-diff-whitespace";

describe("filterWhitespaceOnlyChanges", () => {
  it("rebuilds Pierre layout metadata after replacing and removing whitespace-only changes", () => {
    const [parsed] = parseGitDiffFiles([
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -2,4 +2,4 @@",
      "-const first=1;",
      "+const first = 1;",
      " unchanged",
      "-oldValue",
      "+newValue",
      " trailing",
      "@@ -10 +10 @@",
      "-const second=2;",
      "+const second = 2;",
      "@@ -20 +20 @@",
      "-before",
      "+after",
      "",
    ].join("\n"));

    const filtered = filterWhitespaceOnlyChanges({ ...parsed, cacheKey: "stale-cache-key" });

    expect(filtered).not.toBeNull();
    expect(filtered?.cacheKey).toBeUndefined();
    expect(filtered?.hunks).toHaveLength(2);
    expect(filtered?.hunks[0]).toMatchObject({
      collapsedBefore: 1,
      splitLineStart: 1,
      splitLineCount: 4,
      unifiedLineStart: 1,
      unifiedLineCount: 5,
      additionLines: 1,
      deletionLines: 1,
    });
    expect(filtered?.hunks[1]).toMatchObject({
      collapsedBefore: 14,
      splitLineStart: 19,
      splitLineCount: 1,
      unifiedLineStart: 20,
      unifiedLineCount: 2,
    });
    expect(filtered).toMatchObject({ splitLineCount: 20, unifiedLineCount: 22 });
  });
});
