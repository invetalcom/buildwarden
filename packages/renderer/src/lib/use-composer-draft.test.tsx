/** @vitest-environment happy-dom */
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "./buildwarden-client";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { InstanceContextProvider, type InstanceContextValue } from "./instance-context";
import { scopedId } from "./instance-identity";
import { useComposerDraft, type ComposerDraft } from "./use-composer-draft";
import { composerDraftStore, composerDraftKey } from "./composer-draft-store";

let root: Root;
let container: HTMLDivElement;
let draft: ComposerDraft;
let client: BuildWardenClient;
const Harness = ({ kind, id }: { kind: Parameters<typeof useComposerDraft>[0]; id?: string }) => {
  draft = useComposerDraft(kind, id);
  return <span>{draft.prompt}</span>;
};
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("File", NativeFile);
  client = { draftScopeId: crypto.randomUUID() } as BuildWardenClient;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (kind: Parameters<typeof useComposerDraft>[0], id?: string, instance?: InstanceContextValue) => {
  const content = <BuildWardenClientProvider client={client}><Harness kind={kind} id={id} /></BuildWardenClientProvider>;
  await act(() => root.render(instance ? <InstanceContextProvider value={instance}>{content}</InstanceContextProvider> : content));
};
const settled = async () => {
  await act(async () => { await vi.waitFor(() => expect(draft.loading || draft.saving).toBe(false)); });
};

it("restores project text and attachment contents after navigation and unmount", async () => {
  await render("project", "one");
  await act(() => { draft.setPrompt("First project"); draft.setFiles([new File(["context"], "context.txt")]); });
  await settled();
  await render("project", "two");
  expect(draft.prompt).toBe("");
  expect(draft.files).toEqual([]);
  await act(() => draft.setPrompt("Second project"));
  await act(() => root.render(null));
  await render("project", "one");
  await settled();
  expect(draft.prompt).toBe("First project");
  expect(await draft.files[0]?.text()).toBe("context");
  await render("project", "two");
  expect(draft.prompt).toBe("Second project");
});

it("does not load or subscribe inactive drafts, and retains an in-flight send when hidden", async () => {
  const subscribe = vi.spyOn(composerDraftStore, "subscribe");
  const getSnapshot = vi.spyOn(composerDraftStore, "getSnapshot");
  const key = composerDraftKey(client.draftScopeId!, "run", "inactive");
  const Toggle = ({ active }: { active: boolean }) => { draft = useComposerDraft("run", "inactive", { active }); return null; };
  const show = (active: boolean) => act(() => root.render(<BuildWardenClientProvider client={client}><Toggle active={active} /></BuildWardenClientProvider>));
  try {
    await show(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(draft.beginSubmission()).toBeNull();
    draft.setPrompt("Ignored while inactive");
    expect(localStorage.getItem(key)).toBeNull();
    await show(true);
    await act(() => draft.setPrompt("Pending work"));
    let release!: () => void;
    const submitted = draft;
    await act(() => { release = draft.beginSubmission()!; });
    await show(false);
    expect(composerDraftStore.getSnapshot(key).submitting).toBe(true);
    await show(true);
    expect(draft.prompt).toBe("Pending work");
    expect(draft.submitting).toBe(true);
    await show(false);
    await act(() => { submitted.clearSubmitted(submitted); release(); });
    expect(composerDraftStore.hasDrafts(client.draftScopeId!)).toBe(false);
    await show(true);
    expect(draft.prompt).toBe("");
    expect(draft.submitting).toBe(false);
  } finally { subscribe.mockRestore(); getSnapshot.mockRestore(); }
});

it("binds a late successful send to its original composer after navigation", async () => {
  await render("chat", "one");
  await act(() => { draft.setPrompt("Sending"); draft.setFiles([new File(["sent"], "sent.txt")]); });
  await settled();
  const submitted = draft;
  await render("chat", "two");
  await act(() => draft.setPrompt("Do not clear this"));
  await act(() => submitted.clearSubmitted(submitted));
  expect(draft.prompt).toBe("Do not clear this");
  await render("chat", "one");
  await settled();
  expect(draft.prompt).toBe("");
  expect(draft.files).toEqual([]);
});

it("scopes new chats to the active host and existing runs to their owner", async () => {
  const hostA = crypto.randomUUID();
  const hostB = crypto.randomUUID();
  const context = { activeInstanceId: hostA } as InstanceContextValue;
  await render("new-chat", undefined, context);
  await act(() => draft.setPrompt("New chat on A"));
  await render("new-chat", undefined, { ...context, activeInstanceId: hostB });
  expect(draft.prompt).toBe("");
  await act(() => draft.setPrompt("New chat on B"));
  await render("run", scopedId(hostA, "same-id"), context);
  await act(() => draft.setPrompt("Run on A"));
  await render("run", scopedId(hostA, "same-id"), { ...context, activeInstanceId: hostB });
  expect(draft.prompt).toBe("Run on A");
  await render("run", scopedId(hostB, "same-id"), context);
  expect(draft.prompt).toBe("");
  await render("new-chat", undefined, context);
  expect(draft.prompt).toBe("New chat on A");
});
