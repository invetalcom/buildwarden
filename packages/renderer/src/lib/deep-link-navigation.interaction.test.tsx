/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DeepLinkOpenedPayload, DeepLinkTarget, DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "../components/ui/activity-rich-text";
import { BuildWardenClientProvider } from "./buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./buildwarden-client-core";
import { DeepLinkNavigationContext } from "./deep-links";
import { useDeepLinkSources } from "./use-deep-link-sources";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const RUN_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const CHAT_ID = "0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  window.history.replaceState(null, "", "/");
});

const mount = async (client: BuildWardenClient, node: ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<BuildWardenClientProvider client={client}>{node}</BuildWardenClientProvider>));
  return container;
};

const Sources = ({ enabled, onTarget }: { enabled: boolean; onTarget: (target: DeepLinkTarget) => void }) => {
  useDeepLinkSources({ enabled, onTarget });
  return null;
};

it("opens app links in rendered Markdown in place", async () => {
  const navigate = vi.fn();
  const openExternalUrl = vi.fn();
  const client = createElectronBuildWardenClient({ openExternalUrl } as unknown as DesktopApi);
  const container = await mount(client, (
    <DeepLinkNavigationContext.Provider value={navigate}>
      <ActivityRichText content={`See [the run](buildwarden://run/${RUN_ID}/diff) and [docs](https://example.com).`} />
    </DeepLinkNavigationContext.Provider>
  ));
  const appLink = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "the run");
  expect(appLink?.getAttribute("href")).toBe(`buildwarden://run/${RUN_ID}/diff`);
  await act(async () => appLink!.click());
  expect(navigate).toHaveBeenCalledWith({ kind: "run", runId: RUN_ID, segment: "diff" });
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it("pulls OS-delivered links on the desktop, at startup and on every ping", async () => {
  const pending: (DeepLinkOpenedPayload | null)[] = [
    { url: `buildwarden://run/${RUN_ID}`, target: { kind: "run", runId: RUN_ID } },
    { url: `buildwarden://chat/${CHAT_ID}`, target: { kind: "chat", chatId: CHAT_ID } },
  ];
  let ping: (() => void) | null = null;
  const client = createElectronBuildWardenClient({
    consumePendingDeepLink: vi.fn(async () => pending.shift() ?? null),
    onDeepLinkReceived: vi.fn((listener: () => void) => { ping = listener; return () => { ping = null; }; }),
  } as unknown as DesktopApi);
  const onTarget = vi.fn();

  await mount(client, <Sources enabled={false} onTarget={onTarget} />);
  expect(client.consumePendingDeepLink).not.toHaveBeenCalled();

  await act(async () => root!.render(<BuildWardenClientProvider client={client}><Sources enabled onTarget={onTarget} /></BuildWardenClientProvider>));
  expect(onTarget).toHaveBeenLastCalledWith({ kind: "run", runId: RUN_ID });

  await act(async () => ping!());
  expect(onTarget).toHaveBeenLastCalledWith({ kind: "chat", chatId: CHAT_ID });
  expect(onTarget).toHaveBeenCalledTimes(2);
});

it("reads browser links from the page hash and clears them", async () => {
  window.history.replaceState(null, "", `/app/?ui=desktop#/run/${RUN_ID}/terminal`);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  const webClient = Object.freeze({ ...client, capabilities: Object.freeze({ ...client.capabilities, platform: "web" as const }) });
  const onTarget = vi.fn();

  await mount(webClient, <Sources enabled onTarget={onTarget} />);
  expect(onTarget).toHaveBeenCalledWith({ kind: "run", runId: RUN_ID, segment: "terminal" });
  expect(window.location.hash).toBe("");
  expect(window.location.search).toBe("?ui=desktop");

  window.history.replaceState(null, "", `/app/#/chat/${CHAT_ID}`);
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(onTarget).toHaveBeenLastCalledWith({ kind: "chat", chatId: CHAT_ID });

  window.history.replaceState(null, "", "/app/#pair=abc");
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(onTarget).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe("#pair=abc");
});
