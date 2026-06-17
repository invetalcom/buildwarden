import { useEffect, useMemo, useRef } from "react";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { codeMirrorLanguageExtensionForPath } from "./code-mirror-languages";

const codeMirrorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--ec-input)",
      color: "var(--ec-text)",
      fontSize: "12px",
    },
    ".cm-scroller": {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      lineHeight: "1.55",
    },
    ".cm-content": {
      padding: "10px 0 14px",
      caretColor: "var(--ec-accent)",
    },
    ".cm-line": {
      padding: "0 14px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--ec-panel-muted)",
      borderRight: "1px solid var(--ec-border)",
      color: "var(--ec-faint)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--ec-accent) 12%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--ec-accent) 14%, transparent)",
      color: "var(--ec-text)",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--ec-accent) 28%, transparent)!important",
    },
    ".cm-foldGutter span": {
      color: "var(--ec-faint)",
    },
    ".cm-tooltip": {
      borderColor: "var(--ec-border)",
      backgroundColor: "var(--ec-surface)",
      color: "var(--ec-text)",
    },
  },
  { dark: true },
);

export interface CodeMirrorFileViewerProps {
  content: string;
  filePath: string;
  line?: number | null;
  column?: number | null;
  className?: string;
}

export const CodeMirrorFileViewer = ({ content, filePath, line, column, className }: CodeMirrorFileViewerProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageExtension = useMemo(() => codeMirrorLanguageExtensionForPath(filePath), [filePath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        codeMirrorTheme,
        languageExtension,
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    const targetLine = line && line <= view.state.doc.lines ? view.state.doc.line(line) : null;
    if (targetLine) {
      const columnOffset = column ? Math.max(0, Math.min(column - 1, targetLine.length)) : 0;
      const position = targetLine.from + columnOffset;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
    }

    return () => {
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [column, content, languageExtension, line]);

  return <div ref={hostRef} className={className} />;
};
