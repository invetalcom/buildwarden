/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttentionItem, DesktopApi } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { AttentionInbox } from "./AttentionInbox";
import { filterAttentionItems } from "@buildwarden/shared";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
const items: AttentionItem[] = [
  { id: "a", kind: "approval", projectId: "p", projectName: "Project", runId: "r", title: "Fix tests", detail: "pnpm test", createdAt: "2026-10-03T00:00:00Z", dismissible: false },
  { id: "b", kind: "review", projectId: "q", projectName: "Other", runId: "s", title: "Build UI", detail: "Completed", createdAt: "2026-10-03T00:00:00Z", dismissible: true },
];
const render = async (readOnly = false) => {
  const acknowledge = vi.fn(async () => undefined);
  const getItems = vi.fn(async () => items);
  const client = createElectronBuildWardenClient({ getAttentionInbox: getItems, acknowledgeAttentionItem: acknowledge,
    onRunEvent: () => () => {}, onOrchestrationChanged: () => () => {}, onRunForgeRequestChanged: () => () => {},
  } as unknown as DesktopApi);
  const onOpenRun = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<AttentionInbox client={{ ...client, capabilities: { ...client.capabilities, runMutations: !readOnly } }} onOpenRun={onOpenRun} />));
  await act(async () => container.querySelector("button")?.click());
  return { acknowledge, onOpenRun };
};
describe("attention inbox", () => {
  it("filters projects, categories and content", () => {
    expect(filterAttentionItems(items, "approval", "p", "TEST")).toEqual([items[0]]);
    expect(filterAttentionItems(items, "review", "p", "")).toEqual([]);
  });
  it("opens the correct run and offers acknowledgement only for notices", async () => {
    const { acknowledge, onOpenRun } = await render();
    const dialog = document.querySelector("dialog")!;
    const reviewed = [...dialog.querySelectorAll("button")].filter((button) => button.textContent === "Mark reviewed");
    expect(reviewed).toHaveLength(1);
    await act(async () => reviewed[0].click()); expect(acknowledge).toHaveBeenCalledWith("b");
    const open = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Fix tests"));
    await act(async () => open?.click()); expect(onOpenRun).toHaveBeenCalledWith("p", "r");
    expect(document.querySelector("dialog")).toBeNull();
  });
  it("keeps read-only access read-only", async () => {
    await render(true); expect([...document.querySelectorAll("dialog button")].some((button) => button.textContent === "Mark reviewed")).toBe(false);
  });
});
