import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { cn } from "../../lib/cn";
import type { RunBrowserSessionState } from "./RunDetailPage";

const DEFAULT_BROWSER_URL = "about:blank";

const normalizeBrowserUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol =
    /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) || trimmed.startsWith("about:")
      ? trimmed
      : /^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
        ? `http://${trimmed}`
        : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return ["http:", "https:", "about:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

type Props = {
  uiActive?: boolean;
  className?: string;
  session: RunBrowserSessionState;
  onSessionChange: (session: RunBrowserSessionState) => void;
};

export const RunEmbeddedBrowser = ({ className, session, onSessionChange }: Props) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftUrl = session.draftUrl || DEFAULT_BROWSER_URL;
  const currentUrl = session.currentUrl || DEFAULT_BROWSER_URL;
  const history = session.history.length > 0 ? session.history : [currentUrl];
  const historyIndex = Math.min(Math.max(session.historyIndex, 0), history.length - 1);
  const reloadKey = session.reloadKey ?? 0;
  const normalizedCurrentUrl = useMemo(() => normalizeBrowserUrl(currentUrl), [currentUrl]);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const navigateToUrl = (nextUrl: string) => {
    setError(null);
    setIsLoading(true);
    onSessionChange({
      draftUrl: nextUrl,
      currentUrl: nextUrl,
      history: [...history.slice(0, historyIndex + 1), nextUrl],
      historyIndex: historyIndex + 1,
      reloadKey,
    });
  };

  const navigateToDraftUrl = () => {
    const normalized = normalizeBrowserUrl(draftUrl);
    if (!normalized) {
      setError("Enter a valid http(s) URL or localhost address.");
      return;
    }

    navigateToUrl(normalized);
  };

  return (
    <Card className={cn("flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden p-0", className)}>
      <div className="border-b border-zinc-800/80 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-1.5 text-sky-300">
            <Globe className="h-3.5 w-3.5" />
          </div>
          <p className="text-xs font-medium text-zinc-100">Browser</p>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
              aria-label="Go back"
              disabled={!canGoBack}
              onClick={() => {
                const nextIndex = historyIndex - 1;
                const nextUrl = history[nextIndex];
                if (!nextUrl) {
                  return;
                }
                setError(null);
                setIsLoading(true);
                onSessionChange({
                  draftUrl: nextUrl,
                  currentUrl: nextUrl,
                  history,
                  historyIndex: nextIndex,
                  reloadKey,
                });
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
              aria-label="Go forward"
              disabled={!canGoForward}
              onClick={() => {
                const nextIndex = historyIndex + 1;
                const nextUrl = history[nextIndex];
                if (!nextUrl) {
                  return;
                }
                setError(null);
                setIsLoading(true);
                onSessionChange({
                  draftUrl: nextUrl,
                  currentUrl: nextUrl,
                  history,
                  historyIndex: nextIndex,
                  reloadKey,
                });
              }}
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
              aria-label="Reload page"
              onClick={() => {
                setError(null);
                setIsLoading(true);
                onSessionChange({
                  draftUrl,
                  currentUrl,
                  history,
                  historyIndex,
                  reloadKey: reloadKey + 1,
                });
              }}
            >
              {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
              aria-label="Open in external browser"
              disabled={!normalizedCurrentUrl || normalizedCurrentUrl.startsWith("about:")}
              onClick={() => {
                if (normalizedCurrentUrl && !normalizedCurrentUrl.startsWith("about:")) {
                  void window.easycode.openExternalUrl(normalizedCurrentUrl);
                }
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            navigateToDraftUrl();
          }}
        >
          <Input
            value={draftUrl}
            onChange={(event) =>
              onSessionChange({
                draftUrl: event.target.value,
                currentUrl,
                history,
                historyIndex,
                reloadKey,
              })
            }
            placeholder="https://example.com or http://localhost:3000"
            spellCheck={false}
            className="h-9 font-mono text-xs"
          />
          <Button type="submit" size="sm" className="shrink-0">
            Open
          </Button>
        </form>
        <p className="mt-1 text-[10px] text-zinc-500">
          Loads pages inside Easycode. Bare domains default to `https://`; `localhost` defaults to `http://`.
        </p>
        {error ? <p className="mt-1 text-[10px] text-rose-300">{error}</p> : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 bg-zinc-950">
        <iframe
          key={`${currentUrl}-${String(reloadKey)}`}
          src={currentUrl}
          title="Run browser"
          className="h-full w-full border-0 bg-white"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setIsLoading(false)}
        />
      </div>
    </Card>
  );
};
