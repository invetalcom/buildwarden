import type { ProviderType } from "./index";

export type AttentionKind = "approval" | "input" | "failed" | "blocked" | "review" | "update";

export const ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT = 1_000;

export const isAttentionAcknowledgementBatch = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT &&
  value.every((item) => typeof item === "string");

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
      update: kinds.update !== false,
    },
  };
};

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  /** Null for app-wide notices such as provider CLI updates. */
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
  title: string;
  detail: string;
  createdAt: string;
  /** Live requests must be resolved at their source, not hidden. */
  dismissible: boolean;
  /** Set on provider CLI update notices, which are not tied to a run. */
  providerUpdate?: {
    providerType: ProviderType;
    latestVersion: string;
    canAutoUpdate: boolean;
    /** An active run or chat uses this CLI, so updating has to wait. */
    inUse: boolean;
  };
}

export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  approval: "Approval needed", input: "Question", failed: "Failed", blocked: "Blocked", review: "Ready to review", update: "Update available",
};

export const filterAttentionItems = (items: AttentionItem[], kind: string, projectId: string, query: string) => items.filter((item) =>
  (!kind || item.kind === kind) && (!projectId || item.projectId === projectId) &&
  `${item.title} ${item.detail} ${item.projectName ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
