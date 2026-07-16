import { describe, expect, it } from "vitest";
import { codeMirrorLanguageIdForPath } from "./code-mirror-languages";

describe("CodeMirror language detection", () => {
  it("detects existing web and scripting languages by file extension", () => {
    expect(codeMirrorLanguageIdForPath("src/App.tsx")).toBe("typescript");
    expect(codeMirrorLanguageIdForPath("scripts/build.mjs")).toBe("javascript");
    expect(codeMirrorLanguageIdForPath("package.json")).toBe("json");
    expect(codeMirrorLanguageIdForPath("src/styles.scss")).toBe("css");
    expect(codeMirrorLanguageIdForPath("src/index.html")).toBe("html");
    expect(codeMirrorLanguageIdForPath("src/layout.xml")).toBe("xml");
    expect(codeMirrorLanguageIdForPath("README.md")).toBe("markdown");
    expect(codeMirrorLanguageIdForPath("tools/analyze.py")).toBe("python");
  });

  it("detects backend-oriented formats used in run file previews", () => {
    expect(codeMirrorLanguageIdForPath("cmd/server/main.go")).toBe("go");
    expect(codeMirrorLanguageIdForPath("Backend/src/main/java/com/invetal/stockgenious/SellInitiator.java")).toBe("java");
    expect(codeMirrorLanguageIdForPath("crates/runtime/src/lib.rs")).toBe("rust");
    expect(codeMirrorLanguageIdForPath("db/migrations/001-create-trades.sql")).toBe("sql");
    expect(codeMirrorLanguageIdForPath(".github/workflows/test.yml")).toBe("yaml");
  });

  it("returns null for unsupported plain-text files", () => {
    expect(codeMirrorLanguageIdForPath("notes/todo.txt")).toBeNull();
    expect(codeMirrorLanguageIdForPath("Makefile")).toBeNull();
  });
});
