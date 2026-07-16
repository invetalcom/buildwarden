import { describe, expect, it } from "vitest";
import {
  countChangedFilesInDiff,
  diffFileMatchesPath,
  diffFileMatchesQuery,
  parseGitDiffFiles,
  summarizeDiffStats,
} from "./git-diff-utils";

const PATCH = `diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,3 @@
-const value = 1;
+const value = 2;
 keep
+added
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

describe("git diff utilities", () => {
  it("counts files through the Diffs.com patch parser", () => {
    expect(countChangedFilesInDiff(PATCH)).toBe(2);
  });

  it("renders a headerless hunk through a synthetic Diffs.com patch file", () => {
    expect(countChangedFilesInDiff("@@ -1 +1 @@\n-old\n+new")).toBe(1);
  });

  it("preserves trailing whitespace on the final changed line", () => {
    const [file] = parseGitDiffFiles("@@ -1 +1 @@\n-old\n+new  \t");

    expect(file.additionLines).toEqual(["new  \t"]);
  });

  it("matches renamed files by both their current and previous paths", () => {
    const file = { name: "src/new-name.ts", prevName: "src/old-name.ts" };

    expect(diffFileMatchesPath(file, "a/src/old-name.ts")).toBe(true);
    expect(diffFileMatchesPath(file, "workspace/src/new-name.ts")).toBe(true);
    expect(diffFileMatchesQuery(file, "old-name")).toBe(true);
    expect(diffFileMatchesQuery(file, "new-name")).toBe(true);
    expect(diffFileMatchesPath(file, "src/unrelated.ts")).toBe(false);
  });

  it("summarizes renamed and deleted files", () => {
    expect(summarizeDiffStats(PATCH)).toEqual({
      totalFiles: 2,
      totalAdditions: 2,
      totalDeletions: 2,
      files: [
        { path: "src/new.ts", additions: 2, deletions: 1 },
        { path: "src/gone.ts", additions: 0, deletions: 1 },
      ],
    });
  });

  it("returns an empty summary for non-diff content", () => {
    expect(summarizeDiffStats("not a patch")).toEqual({
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    });
  });
});
