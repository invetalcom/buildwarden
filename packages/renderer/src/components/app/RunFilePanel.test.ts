import { describe, expect, it } from "vitest";
import { filePathMatches, loadedDiffHasFile } from "./RunFilePanel";

describe("run file panel helpers", () => {
  it("matches exact and suffix diff paths", () => {
    expect(filePathMatches("src/App.tsx", "src/App.tsx")).toBe(true);
    expect(filePathMatches("packages/app/src/App.tsx", "src/App.tsx")).toBe(true);
    expect(filePathMatches("b/src/App.tsx", "src/App.tsx")).toBe(true);
  });

  it("does not match unrelated files", () => {
    expect(filePathMatches("src/App.tsx", "src/App.test.tsx")).toBe(false);
    expect(filePathMatches("src/App.tsx", "other/App.tsx")).toBe(false);
  });

  it("matches both paths of a renamed file in a loaded full diff", () => {
    const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`;

    expect(loadedDiffHasFile(diff, "src/old.ts")).toBe(true);
    expect(loadedDiffHasFile(diff, "src/new.ts")).toBe(true);
    expect(loadedDiffHasFile(diff, "src/unrelated.ts")).toBe(false);
  });
});
