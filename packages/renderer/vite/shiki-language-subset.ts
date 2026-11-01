/**
 * Shiki registers ~240 lazily imported grammars and Vite emits a chunk for each of them, in both the
 * desktop renderer and the embedded web build. Only the languages below keep their real grammar. Every
 * other id (and alias) still resolves, to an empty grammar that renders as plain text, because
 * @pierre/diffs throws for languages that are missing from Shiki's map.
 */
export const HIGHLIGHTED_SHIKI_LANGUAGES = new Set([
  "astro",
  "bat",
  "c",
  "clojure",
  "cmake",
  "cpp",
  "csharp",
  "css",
  "csv",
  "dart",
  "diff",
  "docker",
  "dotenv",
  "elixir",
  "erlang",
  "fsharp",
  "git-commit",
  "git-rebase",
  "go",
  "graphql",
  "groovy",
  "haskell",
  "hcl",
  "html",
  "http",
  "ini",
  "java",
  "javascript",
  "json",
  "json5",
  "jsonc",
  "jsonl",
  "jsx",
  "kotlin",
  "less",
  "log",
  "lua",
  "make",
  "markdown",
  "mdx",
  "nginx",
  "nix",
  "objective-c",
  "perl",
  "php",
  "powershell",
  "prisma",
  "proto",
  "python",
  "r",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scss",
  "shellscript",
  "sql",
  "svelte",
  "swift",
  "terraform",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
  "zig",
]);

const SHIKI_LANGUAGE_MAP_MODULE = /[\\/]shiki[\\/]dist[\\/]langs-bundle-full-[^\\/]+\.mjs$/;
const LANGUAGE_ENTRY = /\{\s*"id": "([^"]+)",[^{}]*?"import": \(\(\) => import\("@shikijs\/langs\/\1"\)\)\s*\}/g;
const LANGUAGE_IMPORT = /"import": \(\(\) => import\("@shikijs\/langs\/[^"]+"\)\)/;
const LANGUAGE_ALIASES = /"aliases": (\[[^\]]*\])/;

export const restrictShikiLanguages = (code: string, highlighted: ReadonlySet<string>): string => {
  const seen = new Set<string>();
  const restricted = code.replace(LANGUAGE_ENTRY, (entry, id: string) => {
    seen.add(id);
    if (highlighted.has(id)) return entry;
    const aliases = JSON.parse(LANGUAGE_ALIASES.exec(entry)?.[1] ?? "[]") as string[];
    const plainGrammar = JSON.stringify([{ name: id, aliases, scopeName: `text.plain.${id}`, patterns: [] }]);
    return entry.replace(LANGUAGE_IMPORT, `"import": (() => Promise.resolve({ default: ${plainGrammar} }))`);
  });
  const missing = [...highlighted].filter((id) => !seen.has(id));
  if (seen.size === 0 || missing.length > 0) {
    // A Shiki upgrade changed the module layout or renamed a language: fail instead of silently shipping all grammars.
    throw new Error(`Could not restrict Shiki languages (${seen.size === 0 ? "no language entries matched" : `unknown: ${missing.join(", ")}`}).`);
  }
  return restricted;
};

export const shikiLanguageSubsetPlugin = (highlighted: ReadonlySet<string> = HIGHLIGHTED_SHIKI_LANGUAGES) => ({
  name: "buildwarden:shiki-language-subset",
  apply: "build" as const,
  enforce: "pre" as const,
  transform(code: string, id: string) {
    return SHIKI_LANGUAGE_MAP_MODULE.test(id) ? { code: restrictShikiLanguages(code, highlighted), map: null } : null;
  },
});
