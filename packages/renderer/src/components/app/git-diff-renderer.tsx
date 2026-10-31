import { useEffect, useState } from "react";
import { DEFAULT_THEMES, getHighlighterIfLoaded, getHighlighterOptions, preloadHighlighter } from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";

const hasDiffThemes = () => Boolean(getHighlighterIfLoaded({ theme: DEFAULT_THEMES, lang: "text" }));

/** Ensure the first mount can paint code synchronously, even during Strict Mode's ref replay. */
export function GitDiffRenderer<Annotation>(props: FileDiffProps<Annotation, undefined>) {
  const [ready, setReady] = useState(hasDiffThemes);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    // Without themes, Pierre first creates an empty <pre>. A replayed mount hydrates that empty
    // element and loses the original instance's asynchronous render callback. Languages can still
    // load in the background once the themed plain-text rendering is available.
    void preloadHighlighter(getHighlighterOptions("text", {})).then(() => {
      if (!cancelled) setReady(true);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [attempt, ready]);

  if (ready) return <FileDiff {...props} />;

  if (error) {
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--ec-muted)]">
        Could not initialize the diff viewer.
        <Button size="xs" variant="secondary" onClick={() => {
          setError(false);
          setAttempt((current) => current + 1);
        }}>Retry</Button>
      </div>
    );
  }

  return (
    <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--ec-muted)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Loading file diff…
    </p>
  );
}
