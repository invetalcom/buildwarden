import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";

export type CodeMirrorLanguageId =
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "sql"
  | "typescript"
  | "xml"
  | "yaml";

export const codeMirrorLanguageIdForPath = (filePath: string): CodeMirrorLanguageId | null => {
  const lower = filePath.toLowerCase();
  if (/\.(?:ts|tsx|mts|cts)$/.test(lower)) {
    return "typescript";
  }
  if (/\.(?:js|jsx|mjs|cjs)$/.test(lower)) {
    return "javascript";
  }
  if (/\.(?:json|jsonc|jsonl|lock)$/.test(lower) || lower.endsWith("package-lock")) {
    return "json";
  }
  if (/\.(?:css|scss|sass|less|pcss|postcss)$/.test(lower)) {
    return "css";
  }
  if (/\.(?:html|htm|svg)$/.test(lower)) {
    return "html";
  }
  if (/\.(?:xml|xsd|xsl|xslt|wsdl)$/.test(lower)) {
    return "xml";
  }
  if (/\.(?:md|mdx|markdown)$/.test(lower)) {
    return "markdown";
  }
  if (/\.(?:py|pyw)$/.test(lower)) {
    return "python";
  }
  if (/\.go$/.test(lower)) {
    return "go";
  }
  if (/\.java$/.test(lower)) {
    return "java";
  }
  if (/\.rs$/.test(lower)) {
    return "rust";
  }
  if (/\.(?:sql|mysql|pgsql)$/.test(lower)) {
    return "sql";
  }
  if (/\.(?:ya?ml)$/.test(lower)) {
    return "yaml";
  }
  return null;
};

export const codeMirrorLanguageExtensionForPath = (filePath: string): Extension => {
  const lower = filePath.toLowerCase();
  const languageId = codeMirrorLanguageIdForPath(lower);

  switch (languageId) {
    case "typescript":
      return javascript({ typescript: true, jsx: /\.tsx$/.test(lower) });
    case "javascript":
      return javascript({ jsx: /\.jsx$/.test(lower) });
    case "json":
      return json();
    case "css":
      return css();
    case "go":
      return go();
    case "html":
      return html();
    case "xml":
      return xml();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "java":
      return java();
    case "rust":
      return rust();
    case "sql":
      return sql();
    case "yaml":
      return yaml();
    case null:
      return [];
  }
};
