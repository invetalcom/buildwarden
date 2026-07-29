import { describe, expect, it } from "vitest";
import { splitDiffByFile } from "./text-blocks";

describe("splitDiffByFile", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+added",
  ].join("\n");

  it("keys each chunk by the b-side path", () => {
    const chunks = splitDiffByFile(diff);
    expect([...chunks.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(chunks.get("src/b.ts")).toContain("+added");
    expect(chunks.get("src/a.ts")).not.toContain("+added");
  });

  it("returns nothing for text that is not a git diff", () => {
    expect(splitDiffByFile("just some text").size).toBe(0);
  });
});
