import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useBuildWardenClient } from "./buildwarden-client";
import { useInstanceContext } from "./instance-context";
import { parseScopedId } from "./instance-identity";
import { composerDraftKey, composerDraftStore, type ComposerDraftKind, type ComposerDraftSnapshot } from "./composer-draft-store";

export function useComposerDraft(kind: ComposerDraftKind, entityId = "new") {
  const client = useBuildWardenClient();
  const instances = useInstanceContext();
  const owner = parseScopedId(entityId);
  const environment = owner?.instanceId ?? instances?.activeInstanceId ?? (typeof client.draftScopeId === "string" ? client.draftScopeId : "desktop");
  const key = composerDraftKey(environment, kind, owner?.id ?? entityId);
  const subscribe = useCallback((listener: () => void) => composerDraftStore.subscribe(key, listener), [key]);
  const getSnapshot = useCallback(() => composerDraftStore.getSnapshot(key), [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo(() => ({
    beginSubmission: () => composerDraftStore.beginSubmission(key),
    prepareRunBatch: (signature: string) => composerDraftStore.prepareRunBatch(key, signature),
    setPrompt: (value: Parameters<typeof composerDraftStore.setPrompt>[1]) => composerDraftStore.setPrompt(key, value),
    seedPrompt: (value: string) => composerDraftStore.seedPrompt(key, value),
    setFiles: (value: Parameters<typeof composerDraftStore.setFiles>[1]) => composerDraftStore.setFiles(key, value),
    setCaptures: (value: Parameters<typeof composerDraftStore.setCaptures>[1]) => composerDraftStore.setCaptures(key, value),
    clearSubmitted: (submitted: ComposerDraftSnapshot) => composerDraftStore.clearSubmitted(key, submitted),
    removeMissing: (id: string) => composerDraftStore.removeMissing(key, id),
  }), [key]);
  return { ...snapshot, ...actions, blocked: snapshot.loading || snapshot.missing.length > 0 };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;
