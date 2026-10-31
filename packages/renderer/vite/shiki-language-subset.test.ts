import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIGHLIGHTED_SHIKI_LANGUAGES, restrictShikiLanguages } from "./shiki-language-subset";

const readShikiLanguageMap = (): string => {
  // Shiki is a dependency of @pierre/diffs, whose exports are import-only, so resolve from its real directory.
  const pierreDirectory = realpathSync(fileURLToPath(new URL("../node_modules/@pierre/diffs", import.meta.url)));
  const shikiPackage = createRequire(join(pierreDirectory, "package.json")).resolve("shiki/package.json");
  const distDirectory = join(dirname(shikiPackage), "dist");
  const moduleName = readdirSync(distDirectory).find((name) => /^langs-bundle-full-.+\.mjs$/.test(name));
  if (!moduleName) throw new Error("Shiki language map module not found.");
  return readFileSync(join(distDirectory, moduleName), "utf8");
};

describe("restrictShikiLanguages", () => {
  it("keeps real grammars only for highlighted languages in Shiki's language map", () => {
    const restricted = restrictShikiLanguages(readShikiLanguageMap(), HIGHLIGHTED_SHIKI_LANGUAGES);
    const imported = [...restricted.matchAll(/import\("@shikijs\/langs\/([^"]+)"\)/g)].map((match) => match[1]);

    expect(new Set(imported)).toEqual(HIGHLIGHTED_SHIKI_LANGUAGES);
    expect(restricted).toContain('"id": "emacs-lisp"');
  });

  it("resolves other languages and their aliases to a plain-text grammar", async () => {
    const source = `const bundledLanguagesInfo = [
\t{
\t\t"id": "actionscript-3",
\t\t"name": "ActionScript",
\t\t"aliases": ["actionscript", "as3"],
\t\t"import": (() => import("@shikijs/langs/actionscript-3"))
\t},
\t{
\t\t"id": "go",
\t\t"name": "Go",
\t\t"import": (() => import("@shikijs/langs/go"))
\t}
];`;
    const restricted = restrictShikiLanguages(source, new Set(["go"]));
    const plainLoader = /"import": (\(\(\) => Promise\.resolve\(.+\)\))/.exec(restricted)?.[1];

    expect(restricted).toContain('import("@shikijs/langs/go")');
    expect(restricted).not.toContain("@shikijs/langs/actionscript-3");
    const loaded = await (new Function(`return ${plainLoader ?? ""}`)() as () => Promise<{ default: unknown }>)();
    expect(loaded.default).toEqual([
      { name: "actionscript-3", aliases: ["actionscript", "as3"], scopeName: "text.plain.actionscript-3", patterns: [] },
    ]);
  });

  it("fails when the module layout no longer matches", () => {
    expect(() => restrictShikiLanguages("export const bundledLanguages = {};", new Set(["go"]))).toThrow(/no language entries matched/);
    expect(() => restrictShikiLanguages(readShikiLanguageMap(), new Set(["go", "not-a-language"]))).toThrow(/unknown: not-a-language/);
  });
});
