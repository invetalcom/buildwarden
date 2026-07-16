import { useEffect, useRef, useState, type RefObject } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { runWorktreeTerminalSessionId } from "./run-worktree-terminal-session";

const MIN_START_PX = 48;
const MIN_COLS = 20;
const MIN_ROWS = 5;

type Props = {
  runId: string;
  cwd: string;
  disabled?: boolean;
  /** When false, PTY/xterm stay mounted but the panel is hidden (off-screen); refit when this becomes true. */
  uiActive?: boolean;
  openLinksInApp?: boolean;
  onOpenUrlInApp?: (url: string) => void;
  className?: string;
};

const TerminalSurface = ({ disabled, error, cwd, containerRef, className }: Pick<Props, "disabled" | "cwd" | "className"> & {
  error: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
}) => {
  const buildwarden = useBuildWardenClient();
  if (disabled) {
    return (
      <div className={cn("rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-500", className)}>
        Workspace path is not available. Open the project folder in your system terminal instead.
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-terminal-bg)]", className)}>
      {error && (
        <div className="flex flex-col gap-2 border-b border-rose-500/20 bg-rose-500/5 px-3 py-2">
          <p className="text-xs text-rose-200">{error}</p>
          <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => void buildwarden.openSystemTerminalAtPath(cwd)}>
            Open system terminal here
          </Button>
        </div>
      )}
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden p-1" />
    </div>
  );
};

const configureTerminalClipboard = (term: Terminal): void => {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") {
      return true;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    const pasteFromClipboard = (event.shiftKey && event.key === "Insert" && !mod) || (mod && event.key.toLowerCase() === "v");
    if (pasteFromClipboard) {
      void navigator.clipboard.readText().then((text) => {
        if (text) {
          term.paste(text);
        }
      });
      return false;
    }
    return true;
  });
};

export const RunWorktreeTerminal = ({
  runId,
  cwd,
  disabled,
  uiActive = true,
  openLinksInApp = false,
  onOpenUrlInApp,
  className,
}: Props) => {
  const buildwarden = useBuildWardenClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = runWorktreeTerminalSessionId(runId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (disabled || !cwd.trim()) {
      return;
    }

    const el = containerRef.current;
    if (!el) {
      return;
    }

    let cancelled = false;
    let ptyStarted = false;
    let startFailed = false;
    let startPromise: Promise<void> | null = null;
    setError(null);

    const tokens = getComputedStyle(el);
    const themeToken = (name: string, fallback: string): string => tokens.getPropertyValue(name).trim() || fallback;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      theme: {
        background: themeToken("--ec-terminal-bg", "#0d1013"),
        foreground: themeToken("--ec-terminal-fg", "#e7ebee"),
        cursor: themeToken("--ec-terminal-cursor", "#9fb1bf"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const webLinks = new WebLinksAddon((_event, uri) => {
      if (openLinksInApp && onOpenUrlInApp) {
        onOpenUrlInApp(uri);
        return;
      }
      void buildwarden.openExternalUrl(uri);
    });
    term.loadAddon(webLinks);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    configureTerminalClipboard(term);

    const dataSub = term.onData((data) => {
      if (!ptyStarted) {
        return;
      }
      void buildwarden.runTerminalWrite({ sessionId, data });
    });

    const unsubData = buildwarden.onRunTerminalData((payload) => {
      if (payload.sessionId !== sessionId) {
        return;
      }
      term.write(payload.data);
    });

    const unsubExit = buildwarden.onRunTerminalExit((payload) => {
      if (payload.sessionId !== sessionId) {
        return;
      }
      ptyStarted = false;
      term.write(`\r\n\x1b[33m[Shell exited with code ${String(payload.exitCode)}]\x1b[0m\r\n`);
    });

    const pushSize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      const dims = fit.proposeDimensions();
      const cols = Math.max(MIN_COLS, dims?.cols ?? 80);
      const rows = Math.max(MIN_ROWS, dims?.rows ?? 24);
      if (ptyStarted) {
        void buildwarden.runTerminalResize({ sessionId, cols, rows });
      }
    };

    const ensurePtyStarted = async () => {
      if (cancelled || ptyStarted || startPromise || startFailed) {
        return;
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w < MIN_START_PX || h < MIN_START_PX) {
        return;
      }

      startPromise = (async () => {
        pushSize();
        const result = await buildwarden.runTerminalStart({ sessionId, cwd });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          startFailed = true;
          setError(result.error ?? "Could not start terminal.");
          ro?.disconnect();
          dataSub.dispose();
          unsubData();
          unsubExit();
          term.dispose();
          termRef.current = null;
          fitRef.current = null;
          return;
        }
        ptyStarted = true;
        if (result.reused) {
          term.writeln(
            "\r\n\x1b[90m[Same shell session - prior scrollback is not replayed; press Enter if you do not see a prompt.]\x1b[0m\r\n",
          );
        }
        pushSize();
      })();

      try {
        await startPromise;
      } finally {
        startPromise = null;
      }
    };

    const ro = new ResizeObserver(() => {
      pushSize();
      void ensurePtyStarted();
    });
    ro.observe(el);

    requestAnimationFrame(() => {
      pushSize();
      void ensurePtyStarted();
    });

    return () => {
      cancelled = true;
      ro.disconnect();
      dataSub.dispose();
      unsubData();
      unsubExit();
      /** Keep PTY alive so switching runs and returning preserves the shell (see `killRunTerminalForRunId`). */
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [buildwarden, runId, cwd, disabled, openLinksInApp, onOpenUrlInApp, sessionId]);

  /** After the panel becomes visible again, refit + focus (layout swaps break xterm). */
  useEffect(() => {
    if (!uiActive || disabled) {
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) {
      return;
    }

    const sid = runWorktreeTerminalSessionId(runId);
    const pushSizeAndFocus = () => {
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        const cols = Math.max(MIN_COLS, dims?.cols ?? 80);
        const rows = Math.max(MIN_ROWS, dims?.rows ?? 24);
        void buildwarden.runTerminalResize({ sessionId: sid, cols, rows });
        term.focus();
      } catch {
        /* ignore */
      }
    };

    const t0 = requestAnimationFrame(() => {
      pushSizeAndFocus();
      requestAnimationFrame(pushSizeAndFocus);
    });
    const t1 = window.setTimeout(pushSizeAndFocus, 80);

    return () => {
      cancelAnimationFrame(t0);
      window.clearTimeout(t1);
    };
  }, [buildwarden, uiActive, disabled, runId]);

  return <TerminalSurface disabled={disabled} error={error} cwd={cwd} containerRef={containerRef} className={className} />;
};
