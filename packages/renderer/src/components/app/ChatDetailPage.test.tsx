/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ChatDetail, DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatDetailPage } from "./ChatDetailPage";

vi.mock("./RunComposer", () => ({ RunComposer: () => null }));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.restoreAllMocks());

it("renders authoritative detail props and delegates pagination without fetching or subscribing", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const getChatDetail = vi.fn();
  const getEarlierChatHistory = vi.fn();
  const onChatEvent = vi.fn();
  const loadEarlier = vi.fn(async () => {});
  const client = createElectronBuildWardenClient({ getChatDetail, getEarlierChatHistory, onChatEvent } as unknown as DesktopApi);
  const props: ComponentProps<typeof ChatDetailPage> = {
    chatDetail: {
      chat: { id: "a", modelId: "model", status: "completed", updatedAt: "2026-01-01" } as ChatDetail["chat"],
      steps: [], historyPage: { beforeCursor: "cursor", snapshotRevision: "revision", hasMore: true },
    },
    modelOptions: [], keyboardShortcuts: {} as ComponentProps<typeof ChatDetailPage>["keyboardShortcuts"],
    busy: false, isBookmarked: false, onBack: vi.fn(), onFollowUp: vi.fn(), onCancel: vi.fn(),
    onAddBookmark: vi.fn(), onRemoveBookmark: vi.fn(), onLoadEarlierHistory: loadEarlier,
  };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
  const render = () => act(() => root.render(<BuildWardenClientProvider client={client}><ChatDetailPage {...props} /></BuildWardenClientProvider>));
  try {
    await render();
    const earlier = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Load earlier turns"));
    expect(earlier).toBeDefined();
    await act(() => earlier!.click());
    expect(loadEarlier).toHaveBeenCalledOnce();
    props.chatDetail = { ...props.chatDetail, chat: { ...props.chatDetail.chat, status: "cancelled" } };
    await render();
    expect(container.textContent).toContain("cancelled");
    expect(getChatDetail).not.toHaveBeenCalled();
    expect(getEarlierChatHistory).not.toHaveBeenCalled();
    expect(onChatEvent).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
