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

export const loadCodeMirrorLanguageExtensionForPath = async (filePath: string): Promise<Extension> => {
  const lower = filePath.toLowerCase();
  const languageId = codeMirrorLanguageIdForPath(lower);

  switch (languageId) {
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: /\.tsx$/.test(lower) });
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: /\.jsx$/.test(lower) });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case null:
      return [];
  }
};
