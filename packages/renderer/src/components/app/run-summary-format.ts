import type { RunRecord } from "@buildwarden/shared";

export const formatRunRelativeTime = (dateString: string | null) => {
  if (!dateString) return "just now";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - new Date(dateString).getTime()) / 60000));
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${String(diffMinutes)}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${String(diffHours)}h ago`;
  return `${String(Math.floor(diffHours / 24))}d ago`;
};

export const formatRunDuration = (run: RunRecord) => {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = new Date(run.finishedAt ?? run.updatedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  if (totalSeconds < 5) return "< 5s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
};
