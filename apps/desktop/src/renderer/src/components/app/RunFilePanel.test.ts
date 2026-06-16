import { describe, expect, it } from "vitest";
import { filePathMatches } from "./RunFilePanel";

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
});
