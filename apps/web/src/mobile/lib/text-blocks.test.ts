import { describe, expect, it } from "vitest";
import { splitDiffByFile, splitFencedBlocks } from "./text-blocks";

describe("splitFencedBlocks", () => {
  it("separates prose from fenced code and keeps the language", () => {
    expect(splitFencedBlocks("Before\n```ts\nconst a = 1;\n```\nAfter")).toEqual([
      { kind: "text", content: "Before\n" },
      { kind: "code", language: "ts", content: "const a = 1;\n" },
      { kind: "text", content: "\nAfter" },
    ]);
  });

  it("handles a fence with no language", () => {
    expect(splitFencedBlocks("```\nplain\n```")).toEqual([{ kind: "code", language: "", content: "plain\n" }]);
  });

  it("leaves an unterminated fence as prose rather than swallowing the rest", () => {
    expect(splitFencedBlocks("text ```ts\nnever closed")).toEqual([
      { kind: "text", content: "text ```ts\nnever closed" },
    ]);
  });

  it("drops blank segments", () => {
    expect(splitFencedBlocks("   ")).toEqual([]);
  });
});

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
