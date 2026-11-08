/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { sessionTitle, type ChatDetail, type ChatEvent, type RunDetail, type RunEvent } from "@buildwarden/shared";
import { useRunDetail } from "./use-run-detail";
import { useChatDetail } from "./use-chat-detail";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.useRealTimers(); });

const Run = ({ client }: { client: BuildWardenClient }) => {
  const { detail } = useRunDetail(client, "session-1");
  return <output>{detail ? sessionTitle(detail.run) : "loading"}</output>;
};
const Chat = ({ client }: { client: BuildWardenClient }) => {
  const { detail } = useChatDetail(client, "session-1");
  return <output>{detail ? sessionTitle(detail.chat) : "loading"}</output>;
};

it.each(["run", "chat"] as const)("updates a mobile %s title live and restores the prompt when settings change", async (kind) => {
  vi.useFakeTimers();
  let settingsChanged!: () => void;
  let runChanged!: (event: RunEvent) => void;
  let chatChanged!: (event: ChatEvent) => void;
  const unsubscribeSettings = vi.fn();
  let session = { id: "session-1", prompt: "Original user request", title: "First title" as string | null, titleGenerationEnabled: true };
  const getRunDetail = vi.fn(async () => ({ run: session, steps: [], notes: [] } as unknown as RunDetail));
  const getChatDetail = vi.fn(async () => ({ chat: session, steps: [] } as unknown as ChatDetail));
  const client = {
    getRunDetail, getChatDetail,
    refreshRunForgeRequest: vi.fn(() => new Promise<void>(() => undefined)),
    onRunForgeRequestChanged: () => vi.fn(),
    onRunEvent: (listener: typeof runChanged) => { runChanged = listener; return vi.fn(); },
    onChatEvent: (listener: typeof chatChanged) => { chatChanged = listener; return vi.fn(); },
    onAppSettingsChanged: (listener: typeof settingsChanged) => { settingsChanged = listener; return unsubscribeSettings; },
  } as unknown as BuildWardenClient;
  container = document.createElement("div"); root = createRoot(container);
  await act(async () => root?.render(kind === "run" ? <Run client={client} /> : <Chat client={client} />));
  expect(container.textContent).toBe("First title");
  session = { ...session, title: "Updated title" };
  await act(async () => {
    const event = { runId: session.id, type: "status" as const, title: "Title updated", content: "", createdAt: "2026-11-08", metadata: { sessionTitle: true } };
    if (kind === "run") runChanged({ ...event, run: session as RunDetail["run"] });
    else chatChanged({ ...event, chatId: session.id, chat: session as ChatDetail["chat"] });
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(container.textContent).toBe("Updated title");
  expect(kind === "run" ? getRunDetail : getChatDetail).toHaveBeenCalledOnce();
  session = { ...session, title: null, titleGenerationEnabled: false };
  await act(async () => settingsChanged());
  expect(container.textContent).toBe("Original user request");
  await act(async () => root?.unmount()); root = undefined;
  expect(unsubscribeSettings).toHaveBeenCalledOnce();
});
