import { describe, expect, it } from "vitest";
import { toolWriteFileDiff } from "./tool-write-file-diff";

const diff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-one",
  "+two",
].join("\n");

describe("tool write_file diff", () => {
  it("reads the diff the desktop tools store on the tool result", () => {
    expect(toolWriteFileDiff({ toolName: "write_file", path: "src/app.ts", writeFileUnifiedDiff: diff }, undefined)).toBe(diff);
  });

  it("falls back to the tool call, where codex-cli attaches file-change diffs", () => {
    expect(toolWriteFileDiff({ toolName: "write_file" }, { toolName: "write_file", writeFileUnifiedDiff: diff })).toBe(diff);
  });

  it("ignores metadata without a usable diff", () => {
    expect(toolWriteFileDiff({ toolName: "write_file", path: "src/app.ts" }, undefined)).toBeNull();
    expect(toolWriteFileDiff({ writeFileUnifiedDiff: "Wrote 4636 characters to src/app.ts." })).toBeNull();
    expect(toolWriteFileDiff(undefined, undefined)).toBeNull();
  });
});
