import { getResponseSourceText, type ChatRecord, type ChatSearchDetail } from "@buildwarden/shared";

/** Matches the fields a chat list shows. The host searches the steps (`searchChats`). */
export const chatMatchesSearch = (chat: Pick<ChatRecord, "title" | "prompt">, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return Boolean(chat.title?.toLowerCase().includes(q)) || chat.prompt.toLowerCase().includes(q);
};

/** The whole rule, steps included, for a host that is too old to search by itself. */
export const chatDetailMatchesSearch = (detail: ChatSearchDetail, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return chatMatchesSearch(detail.chat, q) || detail.steps.some(
    (step) =>
      step.title.toLowerCase().includes(q) ||
      getResponseSourceText(step).toLowerCase().includes(q) ||
      step.eventType.toLowerCase().includes(q),
  );
};
