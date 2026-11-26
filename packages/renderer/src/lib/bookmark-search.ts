import type { BookmarkListEntry, BookmarkRecord, ChatBookmarkRecord } from "@buildwarden/shared";

/** Matches the fields a bookmark list shows. The host searches the steps (`searchBookmarks`). */
export const bookmarkEntryMatchesSearch = (bookmark: BookmarkListEntry, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (bookmark.title?.toLowerCase().includes(q) || bookmark.prompt.toLowerCase().includes(q)) return true;
  return "projectName" in bookmark && bookmark.projectName.toLowerCase().includes(q);
};

/** The whole rule, steps included, for a host that is too old to search by itself. */
export const bookmarkMatchesSearch = (bookmark: BookmarkRecord | ChatBookmarkRecord, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return bookmarkEntryMatchesSearch(bookmark, q) || bookmark.steps.some(
    (step) =>
      step.title.toLowerCase().includes(q) ||
      step.content.toLowerCase().includes(q) ||
      step.eventType.toLowerCase().includes(q),
  );
};
