/** @vitest-environment happy-dom */
import { act, createRef, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ChatTranscript, type ChatTranscriptItem } from "./ChatTranscript";
import { RunActivityTimeline } from "./RunActivityTimeline";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { appendResponseCitation, type ResponseCitation } from "../../lib/response-citation";
import { useComposerDraft, type ComposerDraft } from "../../lib/use-composer-draft";
import { useResponseCitation } from "../../lib/use-response-citation";
import { getFileResponseCitation } from "@buildwarden/shared";
import { extractAttachmentPayloadsFromMetadata } from "@buildwarden/shared";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ResponseCitationContext } from "../../lib/response-citation-context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root = createRoot(container);
const client = createElectronBuildWardenClient({} as DesktopApi);
const step = (id: string, content: string, metadata = {}): ChatTranscriptItem => ({
  id, content, metadataJson: JSON.stringify(metadata), eventType: "output", title: "Assistant", createdAt: "2026-11-17T10:00:00Z",
});

it("previews a persisted citation and returns to its source", async () => {
  document.body.append(container);
  const reveal = vi.fn(() => true);
  const attachments = extractAttachmentPayloadsFromMetadata({ attachments: [{ fileName: "quote.txt", mimeType: "text/plain", dataBase64: btoa("A saved quote"), responseCitation: { kind: "cite", stepId: "source", excerpt: "A saved quote" } }] });
  await act(() => root.render(<ResponseCitationContext.Provider value={reveal}><StoredChatAttachments attachments={attachments} /></ResponseCitationContext.Provider>));
  await act(() => container.querySelector<HTMLButtonElement>('[title="A saved quote"]')!.click());
  expect(document.querySelector("dialog pre")?.textContent).toBe("A saved quote");
  await act(() => [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Go to source")!.click());
  expect(reveal).toHaveBeenCalledWith("source");
  expect(document.querySelector("dialog")).toBeNull();
  await act(() => container.querySelector<HTMLButtonElement>('[title="A saved quote"]')!.click());
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click());
  expect(document.querySelector("dialog")).toBeNull();
});

it("does not transfer a removed attachment's pending preview to the next citation", async () => {
  document.body.append(container);
  let finish!: (text: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const makeFile = (text: string) => Object.assign(new File([text], "quote.txt", { lastModified: 1 }), {
    responseCitation: { kind: "cite", stepId: text, excerpt: text },
  });
  const first = makeFile("First");
  const second = makeFile("Other");
  vi.spyOn(first, "text").mockReturnValue(pending);
  const render = (files: File[]) => act(() => root.render(<ChatAttachmentPicker files={files} onChange={() => {}} />));
  await render([first, second]);
  await act(() => container.querySelector<HTMLButtonElement>('[title="First"]')!.click());
  await render([second]);
  await act(async () => { finish("First"); await pending; });
  expect(document.querySelector("dialog")).toBeNull();
  await act(() => container.querySelector<HTMLButtonElement>('[title="Other"]')!.click());
  expect(document.querySelector("dialog pre")?.textContent).toBe("Other");
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  root = createRoot(container);
});

it("exposes source navigation to the composer even when a virtual row is not mounted", async () => {
  document.body.append(container);
  const navigation = createRef<(stepId: string) => boolean>();
  const file = Object.assign(new File(["Original answer"], "reply.txt"), { responseCitation: { kind: "reply", stepId: "source", excerpt: "Original answer" } });
  await act(() => root.render(<BuildWardenClientProvider client={client}><RunActivityTimeline
    steps={[step("source", "Original answer")]}
    run={{ id: "run", status: "completed", mode: "code" }} virtualized responseNavigationRef={navigation}
  /><ChatAttachmentPicker files={[file]} onChange={() => {}} onRevealResponse={(id) => navigation.current?.(id) ?? false} /></BuildWardenClientProvider>));
  expect(container.querySelector('[data-response-id="source"]')).toBeNull();
  let found = false;
  await act(() => { found = navigation.current!("source"); });
  expect(found).toBe(true);
  await act(() => container.querySelector<HTMLButtonElement>('[title="Original answer"]')!.click());
  expect(document.querySelector("dialog [role=status]")).toBeNull();
  await act(() => [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Go to source")!.click());
  expect(document.querySelector("dialog")).toBeNull();
  expect(navigation.current!("missing")).toBe(false);
  await act(() => root.render(null));
  expect(navigation.current).toBeNull();
});

it("replies with source Markdown, cites only text inside that answer, and hides actions on read-only history", async () => {
  document.body.append(container);
  const cite = vi.fn();
  const answer = step("answer", "First **important** point.", { responseSourceText: "First **important** point.\n![Diagram](diagram.png)" });
  const render = (readOnly = false) => act(() => root.render(<BuildWardenClientProvider client={client}>
    <ChatTranscript items={[answer, step("other", "Other response")]} emptyMessage="Empty" onCiteResponse={cite} readOnly={readOnly} />
  </BuildWardenClientProvider>));
  await render();
  const reply = container.querySelector<HTMLButtonElement>('[aria-label="Reply to response"]')!;
  expect(reply.textContent).toBe("");
  expect(reply.title).toBe("Reply to response");
  expect(reply.parentElement?.querySelector('[title="Copy output"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Cite");
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Reply to response"]')!.click());
  expect(cite).toHaveBeenLastCalledWith({ stepId: "answer", text: "First **important** point.\n![Diagram](diagram.png)", kind: "reply" });
  const select = (start: Node, end: Node = start) => act(() => {
    const range = document.createRange();
    range.setStart(start, 0); range.setEnd(end, end.textContent!.length);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const text = container.querySelector("strong")!.firstChild!;
  await select(text);
  await act(() => text.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 100 })));
  const citeButton = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(citeButton.textContent).toContain("Cite selected text");
  await act(() => citeButton.click());
  expect(cite).toHaveBeenLastCalledWith({ stepId: "answer", text: "important", kind: "cite" });
  await select(text, container.querySelectorAll(".chat-message-body--assistant p")[1]!.firstChild!);
  await act(() => text.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await render(true);
  expect(container.querySelector('[aria-label="Reply to response"]')).toBeNull();
});

it.each(["chat", "run"] as const)("keeps sent quotes readable and navigates within the %s transcript", async (kind) => {
  const answer = step("answer", "Use a transaction.");
  const prompt = step("prompt", appendResponseCitation("Please explain", { kind: "reply", stepId: "answer", text: answer.content }), { source: "user" });
  const render = (includeSource: boolean) => act(() => root.render(<BuildWardenClientProvider client={client}>
    {kind === "chat" ? <ChatTranscript items={includeSource ? [answer, prompt] : [prompt]} emptyMessage="Empty" />
      : <RunActivityTimeline steps={includeSource ? [answer, prompt] : [prompt]} run={{ id: "run", status: "completed", mode: "code" }} />}
  </BuildWardenClientProvider>));
  await render(true);
  const source = container.querySelector<HTMLElement>('[data-response-id="answer"]')!;
  const scroll = vi.spyOn(source, "scrollIntoView");
  const clickLink = () => act(() => container.querySelector<HTMLButtonElement>('[title="Go to the original response"]')!.click());
  await clickLink();
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  expect(container.querySelector("blockquote")?.textContent).toContain("Use a transaction.");
  expect(container.querySelector('a[target="_blank"]')).toBeNull();
  await render(false);
  await clickLink();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Source not in the loaded history");
  expect(container.querySelector("blockquote")?.textContent).toContain("Use a transaction.");
});

it("replies to grouped run outputs without including reasoning or user prompts", async () => {
  const cite = vi.fn();
  await act(() => root.render(<BuildWardenClientProvider client={client}><RunActivityTimeline
    steps={[step("user", "User prompt", { source: "user" }), step("reason", "Private reasoning", { assistantKind: "reasoning" }), step("a", "First part"), step("b", "Second part")]}
    run={{ id: "run", status: "completed", mode: "code" }} onCiteResponse={cite}
  /></BuildWardenClientProvider>));
  const replies = container.querySelectorAll<HTMLButtonElement>('[aria-label="Reply to response"]');
  expect(replies).toHaveLength(1);
  expect(replies[0]!.textContent).toBe("");
  expect(replies[0]!.parentElement?.querySelector('[aria-label="Copy response"]')).not.toBeNull();
  await act(() => replies[0]!.click());
  expect(cite).toHaveBeenCalledWith({ stepId: "a", text: "First part\n\nSecond part", kind: "reply" });
});

it("renders cited literal Markdown and entities unchanged, with a safely encoded source id", async () => {
  const text = "Use *literal* <tag> &copy; [text](https://example.com).";
  const prompt = appendResponseCitation("", { kind: "cite", stepId: "id)with spaces", text });
  expect(prompt).toContain("#buildwarden-response-id%29with%20spaces");
  await act(() => root.render(<BuildWardenClientProvider client={client}><ChatTranscript
    items={[step("user", prompt, { source: "user" })]} emptyMessage="Empty"
  /></BuildWardenClientProvider>));
  expect(container.querySelector("blockquote")?.textContent?.trim()).toBe(text);
  // Bare URLs may auto-link, but the selected Markdown link must stay literal text.
  expect(container.querySelector("blockquote a")?.textContent).not.toBe("text");
});

it.each(["run", "chat", "run-chat"] as const)("preserves %s drafts and citations across navigation and a failed send", async (kind) => {
  let draft!: ComposerDraft;
  let cite: ((citation: ResponseCitation) => void) | undefined;
  const owner = crypto.randomUUID();
  const Harness = ({ id, disabled = false }: { id: string; disabled?: boolean }) => {
    draft = useComposerDraft(kind, id);
    const input = useRef<HTMLTextAreaElement>(null);
    cite = useResponseCitation(draft, input, disabled);
    return <textarea ref={input} value={draft.prompt} onChange={() => {}} />;
  };
  const render = (id: string = owner, disabled = false) => act(() => root.render(<BuildWardenClientProvider client={client}><Harness id={id} disabled={disabled} /></BuildWardenClientProvider>));
  await render();
  await act(() => draft.setPrompt("Existing instructions"));
  const textarea = container.querySelector("textarea")!;
  textarea.setSelectionRange(3, 7);
  const existingFile = new File(["context"], "context.txt");
  await act(() => draft.setFiles([existingFile]));
  await act(() => cite!({ kind: "cite", stepId: "earlier", text: "a < b and *literal*" }));
  const saved = draft.prompt;
  expect(saved).toBe("Existing instructions");
  expect(textarea.selectionStart).toBe(3);
  expect(textarea.selectionEnd).toBe(7);
  expect(draft.files).toHaveLength(2);
  expect(draft.files[0]).toBe(existingFile);
  expect(draft.files[1]!.name).toBe("Cited assistant response.txt");
  expect(getFileResponseCitation(draft.files[1]!)).toEqual({ kind: "cite", stepId: "earlier", excerpt: "a < b and *literal*" });
  expect(await draft.files[1]!.text()).toBe("a < b and *literal*");
  await act(() => cite!({ kind: "reply", stepId: "other", text: "Short reply" }));
  expect(draft.prompt).toBe(saved);
  expect(draft.files).toHaveLength(3);
  expect(await draft.files[2]!.text()).toBe("Short reply");
  await act(async () => { cite!({ kind: "reply", stepId: "other", text: "Short reply" }); cite!({ kind: "reply", stepId: "other", text: "Short reply" }); });
  expect(draft.files).toHaveLength(3);
  await render("different"); expect(draft.prompt).toBe("");
  await render(); expect(draft.prompt).toBe(saved);
  expect(draft.files).toHaveLength(3);
  let release!: () => void;
  await act(() => { release = draft.beginSubmission()!; });
  expect(cite).toBeUndefined();
  // A failed request releases ownership without clearing its submitted draft.
  await act(() => release());
  expect(draft.prompt).toBe(saved);
  expect(draft.files).toHaveLength(3);
  await render(owner, true); expect(cite).toBeUndefined();
  await render();
  const submitted = draft;
  await act(() => submitted.clearSubmitted(submitted));
  expect(draft.prompt).toBe("");
  expect(draft.files).toHaveLength(0);
  await act(() => draft.setFiles(Array.from({ length: 8 }, () => new File(["data"], "context.txt"))));
  expect(cite).toBeDefined();
  expect((cite as typeof cite & { disabledReason: string })?.disabledReason).toContain("Attachment limit reached");
});
