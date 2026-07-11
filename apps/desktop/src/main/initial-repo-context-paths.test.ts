import { describe, expect, it } from "vitest";
import { extractPromptPathHints } from "./initial-repo-context";

describe("extractPromptPathHints", () => {
  it("extracts repository paths and source file names from prose", () => {
    expect(
      extractPromptPathHints("Refactor `apps/desktop/src/App.tsx`, compare ./packages/shared/src/index.ts and README.md."),
    ).toEqual(["apps/desktop/src/App.tsx", "packages/shared/src/index.ts", "README.md"]);
  });

  it("deduplicates and caps hints", () => {
    const repeated = Array.from({ length: 20 }, (_, index) => `src/file-${String(index)}.ts`).join(" ");
    expect(extractPromptPathHints(`${repeated} src/file-0.ts`)).toHaveLength(12);
  });

  it("ignores ordinary prose and binary file names", () => {
    expect(extractPromptPathHints("Please improve quality and inspect logo.png when done.")).toEqual([]);
  });
});
