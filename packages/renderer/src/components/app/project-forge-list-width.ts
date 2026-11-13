import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

/** The PR/MR list and the issue list share one remembered width, so switching between them does not jump. */
const REQUEST_LIST_WIDTH_STORAGE_KEY = "buildwarden:project-pr-mr-request-list-width";
export const DEFAULT_REQUEST_LIST_WIDTH = 288;
const MIN_REQUEST_LIST_WIDTH = 220;
const MAX_REQUEST_LIST_WIDTH = 520;

export const clampRequestListWidth = (width: number) => Math.min(MAX_REQUEST_LIST_WIDTH, Math.max(MIN_REQUEST_LIST_WIDTH, Math.round(width)));

export const readStoredRequestListWidth = () => {
  try {
    const raw = window.localStorage.getItem(REQUEST_LIST_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_REQUEST_LIST_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampRequestListWidth(parsed) : DEFAULT_REQUEST_LIST_WIDTH;
  } catch {
    return DEFAULT_REQUEST_LIST_WIDTH;
  }
};

export const writeStoredRequestListWidth = (width: number) => {
  try {
    window.localStorage.setItem(REQUEST_LIST_WIDTH_STORAGE_KEY, String(clampRequestListWidth(width)));
  } catch {
    // Local storage can be unavailable in constrained webviews; resizing should still work for the session.
  }
};

/** Drag-to-resize state for a list column whose width is exposed as the `--pr-mr-request-list-width` CSS variable. */
export const useForgeListWidth = () => {
  const [width, setWidth] = useState(readStoredRequestListWidth);
  const [resizing, setResizing] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: MouseEvent) => {
      if (!start.current) return;
      const next = clampRequestListWidth(start.current.width + event.clientX - start.current.x);
      latest.current = next;
      setWidth(next);
    };
    const onUp = () => {
      start.current = null;
      setResizing(false);
      writeStoredRequestListWidth(latest.current);
    };
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, width: latest.current };
    setResizing(true);
  }, []);

  const style = useMemo(() => ({ "--pr-mr-request-list-width": `${String(width)}px` }) as CSSProperties, [width]);
  return { style, resizing, startResize };
};
