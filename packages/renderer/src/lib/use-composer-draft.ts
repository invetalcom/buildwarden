import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useBuildWardenClient } from "./buildwarden-client";
import { useInstanceContext } from "./instance-context";
import { parseScopedId } from "./instance-identity";
import { composerDraftKey, composerDraftStore, type ComposerDraftKind, type ComposerDraftSnapshot } from "./composer-draft-store";

const inactiveSnapshot: ComposerDraftSnapshot = {
  attachmentIds: [], prompt: "", files: [], captures: [], readOnly: true, acquiringLock: false,
  loading: false, saving: false, submitting: false, error: null, missing: [],
};

/** Inactive composers neither load draft attachments nor claim editing ownership. */
export function useComposerDraft(kind: ComposerDraftKind, entityId = "new", { active = true }: { active?: boolean } = {}) {
  const client = useBuildWardenClient();
  const instances = useInstanceContext();
  const owner = parseScopedId(entityId);
  const environment = owner?.instanceId ?? instances?.activeInstanceId ?? (typeof client.draftScopeId === "string" ? client.draftScopeId : "desktop");
  const key = composerDraftKey(environment, kind, owner?.id ?? entityId);
  const subscribe = useCallback((listener: () => void) => active ? composerDraftStore.subscribe(key, listener) : () => {}, [active, key]);
  const getSnapshot = useCallback(() => active ? composerDraftStore.getSnapshot(key) : inactiveSnapshot, [active, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo(() => ({
    prepareRunBatch: (signature: string) => {
      if (!active) throw new Error("Open this composer before starting a run.");
      return composerDraftStore.prepareRunBatch(key, signature);
    },
    setPrompt: (value: Parameters<typeof composerDraftStore.setPrompt>[1]) => { if (active) composerDraftStore.setPrompt(key, value); },
    setSkillIds: (value: string[] | null) => { if (active) composerDraftStore.setSkillIds(key, value); },
    seedPrompt: (value: string) => { if (active) composerDraftStore.seedPrompt(key, value); },
    setFiles: (value: Parameters<typeof composerDraftStore.setFiles>[1]) => { if (active) composerDraftStore.setFiles(key, value); },
    setCaptures: (value: Parameters<typeof composerDraftStore.setCaptures>[1]) => { if (active) composerDraftStore.setCaptures(key, value); },
    clearSubmitted: (submitted: ComposerDraftSnapshot) => composerDraftStore.clearSubmitted(key, submitted),
    removeMissing: (id: string) => { if (active) composerDraftStore.removeMissing(key, id); },
  }), [active, key]);
  return { ...snapshot, ...actions, beginSubmission: () => active ? composerDraftStore.beginSubmission(key, snapshot) : null, blocked: snapshot.readOnly || snapshot.loading || snapshot.missing.length > 0 };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;
