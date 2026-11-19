import type { Language, StreamParser } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";

type Parser = Language["parser"];

type HastNode = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

export type ResponseCodeBlockSource = { code: string; language: string | null };

const textContent = (node: HastNode): string =>
  node.type === "text" ? node.value ?? "" : (node.children ?? []).map(textContent).join("");

/** Reads a fenced block from the `pre` node react-markdown passes to components; null for other `pre`s. */
export const codeBlockFromPre = (node: unknown): ResponseCodeBlockSource | null => {
  const pre = node as HastNode | undefined;
  const elements = (pre?.children ?? []).filter((child) => child.type === "element");
  const code = elements.length === 1 && elements[0].tagName === "code" ? elements[0] : null;
  if (!code) return null;
  const classNames = code.properties?.className;
  const languageClass = (Array.isArray(classNames) ? classNames : [])
    .find((name): name is string => typeof name === "string" && name.startsWith("language-"));
  // Markdown ends every fenced block with a newline; it is not part of the code.
  return { code: textContent(code).replace(/\r?\n$/, ""), language: languageClass?.slice("language-".length).toLowerCase() || null };
};

export const isDiffLanguage = (language: string | null) => language === "diff" || language === "patch" || language === "udiff";

const streamParser = async <State,>(load: () => Promise<StreamParser<State>>): Promise<Parser> => {
  const [{ StreamLanguage }, mode] = await Promise.all([import("@codemirror/language"), load()]);
  return StreamLanguage.define(mode).parser;
};

type ParserLoader = () => Promise<Parser>;

const javascript: ParserLoader = async () => (await import("@codemirror/lang-javascript")).javascriptLanguage.parser;
const jsx: ParserLoader = async () => (await import("@codemirror/lang-javascript")).jsxLanguage.parser;
const typescript: ParserLoader = async () => (await import("@codemirror/lang-javascript")).typescriptLanguage.parser;
const tsx: ParserLoader = async () => (await import("@codemirror/lang-javascript")).tsxLanguage.parser;
const json: ParserLoader = async () => (await import("@codemirror/lang-json")).jsonLanguage.parser;
const css: ParserLoader = async () => (await import("@codemirror/lang-css")).cssLanguage.parser;
const html: ParserLoader = async () => (await import("@codemirror/lang-html")).htmlLanguage.parser;
const xml: ParserLoader = async () => (await import("@codemirror/lang-xml")).xmlLanguage.parser;
const markdown: ParserLoader = async () => (await import("@codemirror/lang-markdown")).markdownLanguage.parser;
const python: ParserLoader = async () => (await import("@codemirror/lang-python")).pythonLanguage.parser;
const go: ParserLoader = async () => (await import("@codemirror/lang-go")).goLanguage.parser;
const java: ParserLoader = async () => (await import("@codemirror/lang-java")).javaLanguage.parser;
const rust: ParserLoader = async () => (await import("@codemirror/lang-rust")).rustLanguage.parser;
const sql: ParserLoader = async () => (await import("@codemirror/lang-sql")).StandardSQL.language.parser;
const postgres: ParserLoader = async () => (await import("@codemirror/lang-sql")).PostgreSQL.language.parser;
const yaml: ParserLoader = async () => (await import("@codemirror/lang-yaml")).yamlLanguage.parser;
const shell: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell);
const powershell: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell);
const c: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).c);
const cpp: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).cpp);
const csharp: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp);
const kotlin: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin);
const scala: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).scala);
const dart: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).dart);
const objectiveC: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/clike")).objectiveC);
const swift: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift);
const ruby: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby);
const toml: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml);
const dockerfile: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
const lua: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua);
const perl: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl);
const r: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/r")).r);
const ini: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties);
const haskell: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/haskell")).haskell);
const erlang: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/erlang")).erlang);
const julia: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/julia")).julia);
const groovy: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/groovy")).groovy);
const cmake: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/cmake")).cmake);
const nginx: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx);
const protobuf: ParserLoader = () => streamParser(async () => (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf);

/** Fence names models commonly use, mapped to parsers that load on first use. */
const PARSER_LOADERS: Record<string, ParserLoader> = {
  js: javascript, javascript, mjs: javascript, cjs: javascript, node: javascript, jsx,
  ts: typescript, typescript, mts: typescript, cts: typescript, tsx,
  json, jsonc: json, json5: json, jsonl: json,
  css, scss: css, sass: css, less: css, pcss: css, postcss: css,
  html, htm: html, xhtml: html, vue: html, svelte: html,
  xml, svg: xml, xaml: xml, plist: xml, xsd: xml, csproj: xml,
  md: markdown, markdown, mdx: markdown,
  py: python, python, python3: python, py3: python, pyw: python,
  go, golang: go,
  java,
  rs: rust, rust,
  sql, mysql: sql, sqlite: sql, tsql: sql, plsql: sql, postgres, postgresql: postgres, psql: postgres, pgsql: postgres,
  yaml, yml: yaml,
  sh: shell, bash: shell, shell, zsh: shell, ksh: shell, console: shell, shellscript: shell, shellsession: shell, terminal: shell,
  ps: powershell, ps1: powershell, psm1: powershell, powershell, pwsh: powershell,
  c, h: c,
  cpp, "c++": cpp, cc: cpp, cxx: cpp, hpp: cpp, hh: cpp, cuda: cpp,
  cs: csharp, csharp, "c#": csharp,
  kt: kotlin, kts: kotlin, kotlin,
  scala, sc: scala,
  dart,
  objc: objectiveC, "objective-c": objectiveC, objectivec: objectiveC,
  swift,
  rb: ruby, ruby, gemfile: ruby,
  toml,
  dockerfile, docker: dockerfile, containerfile: dockerfile,
  lua,
  pl: perl, perl,
  r,
  ini, cfg: ini, conf: ini, properties: ini, env: ini, dotenv: ini, editorconfig: ini, gitconfig: ini,
  hs: haskell, haskell,
  erl: erlang, erlang,
  jl: julia, julia,
  groovy, gradle: groovy,
  cmake,
  nginx,
  proto: protobuf, protobuf,
};

/** Fence info can carry more than the name (```ts title="x.ts"); only the name selects the language. */
export const normalizeCodeLanguage = (language: string | null): string | null => {
  const name = language?.trim().split(/[\s{,]/)[0]?.toLowerCase();
  return name || null;
};

export const hasCodeHighlighter = (language: string | null) => {
  const name = normalizeCodeLanguage(language);
  return Boolean(name && Object.hasOwn(PARSER_LOADERS, name));
};

const parserCache = new Map<string, Promise<Parser | null>>();

export const loadCodeParser = (language: string | null): Promise<Parser | null> => {
  const name = normalizeCodeLanguage(language);
  if (!name || !Object.hasOwn(PARSER_LOADERS, name)) return Promise.resolve(null);
  let pending = parserCache.get(name);
  if (!pending) {
    pending = PARSER_LOADERS[name]().catch(() => {
      parserCache.delete(name);
      return null;
    });
    parserCache.set(name, pending);
  }
  return pending;
};

export type HighlightedCodeLine = Array<{ text: string; className: string }>;

/** Highlighting stops above this size; long generated files stay plain rather than stall streaming. */
export const MAX_HIGHLIGHTED_CODE_LENGTH = 40_000;

export const highlightCodeLines = (code: string, parser: Parser): HighlightedCodeLine[] | null => {
  if (code.length > MAX_HIGHLIGHTED_CODE_LENGTH) return null;
  const lines: HighlightedCodeLine[] = [[]];
  try {
    highlightCode(code, parser.parse(code), classHighlighter,
      (text, className) => lines[lines.length - 1].push({ text, className }),
      () => lines.push([]));
  } catch {
    return null;
  }
  return lines;
};

export type DiffLineKind = "added" | "removed" | "hunk" | "header" | "context";

export const diffLineKind = (line: string): DiffLineKind => {
  if (/^(?:\+\+\+|---)(?:\s|$)/.test(line) || /^(?:diff --git|index [\da-f]|new file mode|deleted file mode|similarity index|rename (?:from|to)) /.test(line)) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
};
