/** Optional fields keep older snapshots and connected hosts compatible. */
export interface SessionTitleFields {
  /** Saved display title; hidden by the host while the feature is disabled. */
  title?: string | null;
  titleGenerationEnabled?: boolean | number;
  titleGenerationPending?: boolean | number;
}

export const SESSION_TITLE_MAX_LENGTH = 120;

export const normalizeSessionTitle = (value: string): string => value.trim().replace(/\s+/gu, " ");

export const sessionTitle = (session: SessionTitleFields & { prompt: string }, fallback = "Untitled"): string => {
  if (session.title?.trim()) return session.title.trim();
  const prompt = session.prompt.trim() || fallback;
  if (!session.titleGenerationEnabled) return prompt;
  const seed = normalizeSessionTitle(prompt);
  return seed.length <= SESSION_TITLE_MAX_LENGTH ? seed : `${seed.slice(0, SESSION_TITLE_MAX_LENGTH - 1)}…`;
};
