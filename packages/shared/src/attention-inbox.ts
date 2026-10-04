export type AttentionKind = "approval" | "input" | "failed" | "blocked" | "review";

export interface AttentionInboxSettings {
  enabled: boolean;
  kinds: Record<AttentionKind, boolean>;
}

export const parseAttentionInboxSettings = (value?: string): AttentionInboxSettings => {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? "{}"); } catch { parsed = {}; }
  const settings = parsed && typeof parsed === "object" ? parsed as Partial<AttentionInboxSettings> : {};
  const kinds: Partial<AttentionInboxSettings["kinds"]> = settings.kinds && typeof settings.kinds === "object" ? settings.kinds : {};
  return {
    enabled: settings.enabled !== false,
    kinds: {
      approval: kinds.approval !== false,
      input: kinds.input !== false,
      failed: kinds.failed !== false,
      blocked: kinds.blocked !== false,
      review: kinds.review !== false,
    },
  };
};

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
