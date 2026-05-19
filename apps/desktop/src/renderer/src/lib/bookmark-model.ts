import type { ModelRecord } from "@easycode/shared";

/** Resolve display name for a bookmarked run/chat model configuration id. */
export function bookmarkModelDisplay(models: ModelRecord[], modelId: string | null | undefined): string {
  if (modelId == null || modelId === "") {
    return "Not recorded";
  }
  const row = models.find((m) => m.id === modelId);
  return row?.displayName ?? "Removed model";
}
