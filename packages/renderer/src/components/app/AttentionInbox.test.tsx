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
const render = async (readOnly = false, initialItems = items, failId?: string) => {
  let remaining = [...initialItems];
  const acknowledge = vi.fn(async (id: string) => {
    if (id === failId) throw new Error("Connection lost");
    remaining = remaining.filter((item) => item.id !== id);
  });
  const getItems = vi.fn(async () => remaining);
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
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog")).toBeNull();
  });
  it.each(["review", "failed"] as const)("marks a %s notice as read when opening it", async (kind) => {
    const { acknowledge, onOpenRun } = await render(false, [{ ...items[1], kind }]);
    const entry = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Build UI"))!;
    await act(async () => entry.click());
    expect(acknowledge).toHaveBeenCalledWith("b");
    expect(onOpenRun).toHaveBeenCalledWith("q", "s");
    expect(document.querySelector("dialog")).toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(document.querySelector("dialog")?.textContent).toContain("Nothing needs your attention.");
  });
  it("keeps the notice available for retry when marking it as read fails", async () => {
    const { acknowledge, onOpenRun } = await render(false, [items[1]], "b");
    const entry = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Build UI"))!;
    await act(async () => entry.click());
    expect(acknowledge).toHaveBeenCalledWith("b");
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Could not mark this notice as read.");
    expect(entry.disabled).toBe(false);
  });
  it("keeps read-only access read-only", async () => {
    const { acknowledge, onOpenRun } = await render(true); expect([...document.querySelectorAll("dialog button")].some((button) => button.textContent === "Mark reviewed")).toBe(false);
    expect([...document.querySelectorAll("dialog button")].some((button) => button.textContent === "Mark all as read")).toBe(false);
    const entry = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Build UI"))!;
    await act(async () => entry.click());
    expect(onOpenRun).toHaveBeenCalledWith("q", "s");
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("uses shared dropdowns inside the modal and filters their selections", async () => {
    await render();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector("select")).toBeNull();
    const project = dialog.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Attention project"]')!;
    await act(async () => project.click());
    const projectMenu = document.querySelector('[role="listbox"]')!;
    expect(projectMenu.closest("dialog")).toBe(dialog);
    await act(async () => [...projectMenu.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "Other")!.click());
    expect(dialog.textContent).toContain("Build UI");
    expect(dialog.textContent).not.toContain("Fix tests");
    const type = dialog.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Attention type"]')!;
    await act(async () => type.click());
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "Approval needed")!.click());
    expect(dialog.textContent).toContain("No matching items.");
  });
  it("marks all result notices as read while keeping unresolved requests", async () => {
    const extra: AttentionItem[] = [
      { ...items[0], id: "question", kind: "input" },
      { ...items[0], id: "blocked", kind: "blocked" },
      ...Array.from({ length: 55 }, (_, index) => ({ ...items[1], id: `result-${index}` })),
    ];
    const { acknowledge } = await render(false, [...items, ...extra]);
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent === "Mark all as read")!;
    await act(async () => button.click());
    expect(acknowledge).toHaveBeenCalledTimes(56);
    expect(acknowledge.mock.calls.flat()).not.toContain("a");
    expect(acknowledge.mock.calls.flat()).not.toContain("question");
    expect(acknowledge.mock.calls.flat()).not.toContain("blocked");
    expect(document.querySelector("dialog h2")?.textContent).toContain("3");
    expect(button.disabled).toBe(true);
  });
  it("refreshes successful acknowledgements and reports a partial failure", async () => {
    const { acknowledge } = await render(false, [items[1], { ...items[1], id: "failed" }], "failed");
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent === "Mark all as read")!;
    await act(async () => button.click());
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(document.querySelector("dialog h2")?.textContent).toContain("1");
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Connection lost");
    expect(button.disabled).toBe(false);
  });
});
