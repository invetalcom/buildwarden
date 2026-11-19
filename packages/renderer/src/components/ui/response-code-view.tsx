import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { writeClipboardText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import {
  diffLineKind, hasCodeHighlighter, highlightCodeLines, isDiffLanguage, loadCodeParser, normalizeCodeLanguage,
} from "../../lib/response-code";

type Parser = Awaited<ReturnType<typeof loadCodeParser>>;

const useCodeParser = (language: string | null): Parser => {
  const [loaded, setLoaded] = useState<{ language: string; parser: Parser } | null>(null);
  useEffect(() => {
    if (!language || !hasCodeHighlighter(language)) return;
    let cancelled = false;
    void loadCodeParser(language).then((parser) => {
      if (!cancelled) setLoaded({ language, parser });
    });
    return () => { cancelled = true; };
  }, [language]);
  return loaded?.language === language ? loaded.parser : null;
};

export const CodeCopyButton = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await writeClipboardText(code))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="response-code-copy" onClick={() => void copy()} title={copied ? "Copied" : "Copy code"} aria-label={copied ? "Copied" : "Copy code"}>
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
    </button>
  );
};

// Block-level lines so added/removed backgrounds span the whole row; they need no newline characters.
const DiffCode = ({ code }: { code: string }) => (
  <>
    {code.split("\n").map((line, index) => (
      <span key={index} className={`response-diff-line response-diff-${diffLineKind(line)}`}>{line || " "}</span>
    ))}
  </>
);

/**
 * A fenced code block shown as code: syntax highlighting (parsers load on first use), a language
 * label and a copy button that appear on hover, and coloured lines for diffs.
 * `preClassName` carries each platform's own block styling.
 */
export const ResponseCodeView = memo(function ResponseCodeView({ code, language, preClassName, extraActions }: {
  code: string;
  language: string | null;
  preClassName?: string;
  /** Additional toolbar buttons, e.g. to switch a rendered diagram back to its source. */
  extraActions?: ReactNode;
}) {
  const name = normalizeCodeLanguage(language);
  const diff = isDiffLanguage(name);
  const parser = useCodeParser(diff ? null : name);
  const lines = useMemo(() => (parser ? highlightCodeLines(code, parser) : null), [code, parser]);
  let content: ReactNode = code;
  if (diff) content = <DiffCode code={code} />;
  else if (lines) {
    content = lines.map((line, lineIndex) => (
      <span key={lineIndex}>
        {line.map((token, tokenIndex) => token.className
          ? <span key={tokenIndex} className={token.className}>{token.text}</span>
          : token.text)}
        {lineIndex < lines.length - 1 ? "\n" : null}
      </span>
    ));
  }
  return (
    <div className="response-code">
      <pre className={cn(preClassName, diff && "response-code-diff")}>
        <code className={name ? `language-${name}` : undefined}>{content}</code>
      </pre>
      <div className="response-code-toolbar">
        {name ? <span className="response-code-language">{name}</span> : null}
        {extraActions}
        <CodeCopyButton code={code} />
      </div>
    </div>
  );
});
