export type AttentionKind = "approval" | "input" | "failed" | "blocked" | "review";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  projectId: string;
  projectName: string;
  runId: string;
  title: string;
  detail: string;
  createdAt: string;
  /** Live requests must be resolved at their source, not hidden. */
  dismissible: boolean;
}

export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  approval: "Approval needed", input: "Question", failed: "Failed", blocked: "Blocked", review: "Ready to review",
};

export const filterAttentionItems = (items: AttentionItem[], kind: string, projectId: string, query: string) => items.filter((item) =>
  (!kind || item.kind === kind) && (!projectId || item.projectId === projectId) &&
  `${item.title} ${item.detail} ${item.projectName}`.toLowerCase().includes(query.trim().toLowerCase()));
