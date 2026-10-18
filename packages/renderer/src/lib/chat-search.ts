import { getResponseSourceText, type ChatSearchDetail } from "@buildwarden/shared";

export const chatDetailMatchesSearch = (detail: ChatSearchDetail, query: string): boolean => {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const { chat, steps } = detail;
  if (chat.prompt.toLowerCase().includes(q)) return true;
  return steps.some(
    (step) =>
      step.title.toLowerCase().includes(q) ||
      getResponseSourceText(step).toLowerCase().includes(q) ||
      step.eventType.toLowerCase().includes(q),
  );
};
