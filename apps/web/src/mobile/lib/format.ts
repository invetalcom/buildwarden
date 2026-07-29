import type { RunRecord } from "@buildwarden/shared";

/** "3m", "5h", "2d" — compact enough for a list row on a 360px screen. */
export const relativeTime = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "";
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const absoluteTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const timestamp = new Date(iso).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "—";
};

export const compactNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

/** First meaningful line of a prompt, for list rows and app-bar titles. */
export const runTitle = (run: Pick<RunRecord, "goalText" | "prompt" | "lineageTitle">): string => {
  const source = run.lineageTitle?.trim() || run.goalText?.trim() || run.prompt.trim();
  const firstLine = source.split("\n").map((line) => line.trim()).find(Boolean) ?? "Untitled run";
  return firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine;
};

export const firstLine = (value: string, fallback = "Untitled"): string => {
  const line = value.split("\n").map((entry) => entry.trim()).find(Boolean) ?? fallback;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/** Trailing path segment — full repo paths never fit on a phone. */
export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const errorMessage = (caught: unknown, fallback = "Something went wrong."): string =>
  caught instanceof Error && caught.message ? caught.message : fallback;
