/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttentionItem, DesktopApi } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { AttentionInbox } from "./AttentionInbox";
import { ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT, filterAttentionItems } from "@buildwarden/shared";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
const items: AttentionItem[] = [
  { id: "a", kind: "approval", projectId: "p", projectName: "Project", runId: "r", title: "Fix tests", detail: "pnpm test", createdAt: "2026-10-03T00:00:00Z", dismissible: false },
  { id: "b", kind: "review", projectId: "q", projectName: "Other", runId: "s", title: "Build UI", detail: "Completed", createdAt: "2026-10-03T00:00:00Z", dismissible: true },
];
const render = async (readOnly = false, initialItems = items, failId?: string, triggerVariant?: "default" | "sidebar" | "titlebar") => {
  let remaining = [...initialItems];
  const acknowledge = vi.fn(async (id: string) => {
    if (id === failId) throw new Error("Connection lost");
    remaining = remaining.filter((item) => item.id !== id);
  });
  const getItems = vi.fn(async () => remaining);
  const acknowledgeMany = vi.fn(async (ids: string[]) => {
    if (failId && ids.includes(failId)) throw new Error("Connection lost");
    remaining = remaining.filter((item) => !ids.includes(item.id));
  });
  const runUpdate = vi.fn(async (providerType: string) => {
    remaining = remaining.filter((item) => item.providerUpdate?.providerType !== providerType);
  });
  const client = createElectronBuildWardenClient({ getAttentionInbox: getItems, acknowledgeAttentionItem: acknowledge,
    acknowledgeAttentionItems: acknowledgeMany,
    runProviderCliUpdate: runUpdate, onProviderCliUpdatesChanged: () => () => {},
    onRunEvent: () => () => {}, onOrchestrationChanged: () => () => {}, onRunForgeRequestChanged: () => () => {},
  } as unknown as DesktopApi);
  const onOpenRun = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<AttentionInbox client={{ ...client, capabilities: { ...client.capabilities, runMutations: !readOnly } }} onOpenRun={onOpenRun} triggerVariant={triggerVariant} />));
  await act(async () => container.querySelector("button")?.click());
  return { acknowledge, acknowledgeMany, onOpenRun, runUpdate };
};
describe("attention inbox", () => {
  it("filters projects, categories and content", () => {
    expect(filterAttentionItems(items, "approval", "p", "TEST")).toEqual([items[0]]);
    expect(filterAttentionItems(items, "review", "p", "")).toEqual([]);
  });
  it("shows a compact title bar trigger with the item count", async () => {
    await render(false, items, undefined, "titlebar");
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toBe("Attention inbox, 2 items");
    expect(trigger.textContent).toBe("2");
    expect(document.querySelector("dialog")).not.toBeNull();
  });
  it("closes on a backdrop click but not after a drag that starts inside the panel", async () => {
    await render(false, items, undefined, "titlebar");
    const dialog = document.querySelector("dialog")!;
    const search = dialog.querySelector("input")!;
    await act(async () => { search.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(document.querySelector("dialog")).not.toBeNull();
    await act(async () => { dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(document.querySelector("dialog")).toBeNull();
  });
  it("opens the correct run and offers acknowledgement only for notices", async () => {
    const { acknowledge, onOpenRun } = await render();
    const dialog = document.querySelector("dialog")!;
    const reviewed = [...dialog.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label") === "Mark as read");
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
    const { acknowledge, acknowledgeMany, onOpenRun } = await render(true); expect([...document.querySelectorAll("dialog button")].some((button) => button.getAttribute("aria-label") === "Mark as read")).toBe(false);
    expect([...document.querySelectorAll("dialog button")].some((button) => button.textContent === "Mark all as read")).toBe(false);
    const entry = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Build UI"))!;
    await act(async () => entry.click());
    expect(onOpenRun).toHaveBeenCalledWith("q", "s");
    expect(acknowledge).not.toHaveBeenCalled();
    expect(acknowledgeMany).not.toHaveBeenCalled();
  });
  it("filters by project dropdown and type chips", async () => {
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
    // Chips list only the types present, each with its count.
    const chips = [...dialog.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Attention type"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual(["All2", "Approval needed1", "Ready to review1"]);
    await act(async () => chips[1]!.click());
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(dialog.textContent).toContain("No matching items.");
  });
  it("keeps active filters visible after their last item resolves", async () => {
    await render();
    const dialog = document.querySelector("dialog")!;
    const project = dialog.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Attention project"]')!;
    await act(async () => project.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "Other")!.click());
    const chip = (label: string) => [...dialog.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Attention type"] button')].find((button) => button.textContent?.startsWith(label));
    await act(async () => chip("Ready to review")!.click());
    const markRead = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Mark as read")!;
    await act(async () => markRead.click());
    expect(dialog.textContent).toContain("No matching items.");
    expect(chip("Ready to review")?.textContent).toBe("Ready to review0");
    expect(chip("Ready to review")?.getAttribute("aria-pressed")).toBe("true");
    expect(dialog.querySelector('[role="combobox"][aria-label="Attention project"]')?.textContent).toContain("Other");
    await act(async () => chip("All")!.click());
    await act(async () => dialog.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Attention project"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "All projects")!.click());
    expect(dialog.textContent).toContain("Fix tests");
  });
  it("marks all result notices as read while keeping unresolved requests", async () => {
    const extra: AttentionItem[] = [
      { ...items[0], id: "question", kind: "input" },
      { ...items[0], id: "blocked", kind: "blocked" },
      ...Array.from({ length: 55 }, (_, index) => ({ ...items[1], id: `result-${index}` })),
    ];
    const { acknowledge, acknowledgeMany } = await render(false, [...items, ...extra]);
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent === "Mark all as read")!;
    await act(async () => button.click());
    expect(acknowledge).not.toHaveBeenCalled();
    expect(acknowledgeMany).toHaveBeenCalledExactlyOnceWith(["b", ...extra.filter((item) => item.dismissible).map((item) => item.id)]);
    expect(document.querySelector("dialog h2")?.textContent).toContain("3");
    expect(button.disabled).toBe(true);
  });
  it("keeps all notices available for retry when the batch fails", async () => {
    const { acknowledgeMany } = await render(false, [items[1], { ...items[1], id: "failed" }], "failed");
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent === "Mark all as read")!;
    await act(async () => button.click());
    expect(acknowledgeMany).toHaveBeenCalledExactlyOnceWith(["b", "failed"]);
    expect(document.querySelector("dialog h2")?.textContent).toContain("2");
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Connection lost");
    expect(button.disabled).toBe(false);
  });
  it("offers update and dismiss actions for provider CLI notices without opening a run", async () => {
    const update: AttentionItem = {
      id: "provider-update:claude-code:2.1.303", kind: "update", projectId: null, projectName: null, runId: null,
      title: "Claude Code v2.1.302 → v2.1.303", detail: "A newer CLI version is available.", createdAt: "2026-10-03T00:00:00Z",
      dismissible: true, providerUpdate: { providerType: "claude-code", latestVersion: "2.1.303", canAutoUpdate: true, inUse: false },
    };
    const { acknowledge, onOpenRun, runUpdate } = await render(false, [items[1], update]);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Update available");
    expect(dialog.textContent).toContain("BuildWarden");
    // App-wide notices do not add a blank project filter option.
    const project = dialog.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Attention project"]')!;
    await act(async () => project.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["All projects", "Other"]);
    await act(async () => project.click());
    expect([...dialog.querySelectorAll("button")].some((button) => button.textContent?.includes("Claude Code v2.1.302"))).toBe(false);
    const dismissButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Dismiss")!;
    expect(dismissButton).toBeDefined();
    const updateButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Update")!;
    await act(async () => updateButton.click());
    expect(runUpdate).toHaveBeenCalledExactlyOnceWith("claude-code");
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(dialog.textContent).not.toContain("Claude Code v2.1.302");
  });
  it("disables the update while the CLI is in use and shows host errors without the IPC prefix", async () => {
    const busy: AttentionItem = {
      id: "provider-update:claude-code:2.1.303", kind: "update", projectId: null, projectName: null, runId: null,
      title: "Claude Code v2.1.302 → v2.1.303", detail: "A newer CLI version is available.", createdAt: "2026-10-03T00:00:00Z",
      dismissible: true, providerUpdate: { providerType: "claude-code", latestVersion: "2.1.303", canAutoUpdate: true, inUse: true },
    };
    const { runUpdate } = await render(false, [busy]);
    const updateButton = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Update")!;
    expect(updateButton.disabled).toBe(true);
    expect(updateButton.title).toContain("In use by an active run or chat");
    expect(runUpdate).not.toHaveBeenCalled();
  });
  it("strips the Electron IPC prefix from update errors", async () => {
    const item: AttentionItem = {
      id: "provider-update:claude-code:2.1.303", kind: "update", projectId: null, projectName: null, runId: null,
      title: "Claude Code v2.1.302 → v2.1.303", detail: "", createdAt: "2026-10-03T00:00:00Z",
      dismissible: true, providerUpdate: { providerType: "claude-code", latestVersion: "2.1.303", canAutoUpdate: true, inUse: false },
    };
    const { runUpdate } = await render(false, [item]);
    runUpdate.mockRejectedValueOnce(new Error("Error invoking remote method 'buildwarden:run-provider-cli-update': Error: Claude Code is in use by an active run or chat. Update it once they finish."));
    const updateButton = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Update")!;
    await act(async () => updateButton.click());
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Claude Code is in use by an active run or chat. Update it once they finish.");
  });
  it("hides the update action for manual-only installs", async () => {
    const manual: AttentionItem = {
      id: "provider-update:codex-cli:0.164.0", kind: "update", projectId: null, projectName: null, runId: null,
      title: "Codex CLI v0.163.0 → v0.164.0", detail: "Run the command from an Administrator terminal.", createdAt: "2026-10-03T00:00:00Z",
      dismissible: true, providerUpdate: { providerType: "codex-cli", latestVersion: "0.164.0", canAutoUpdate: false, inUse: false },
    };
    const { acknowledge } = await render(false, [manual]);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("dialog button")];
    expect(buttons.some((button) => button.textContent === "Update")).toBe(false);
    await act(async () => buttons.find((button) => button.getAttribute("aria-label") === "Dismiss")!.click());
    expect(acknowledge).toHaveBeenCalledWith(manual.id);
  });
  it.each([false, true])("splits a large backlog into bounded batches (later failure: %s)", async (failLater) => {
    const results = Array.from({ length: ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT + 1 }, (_, index) => ({ ...items[1], id: `result-${index}` }));
    const last = results.at(-1)!;
    const { acknowledgeMany } = await render(false, [...items.slice(0, 1), ...results], failLater ? last.id : undefined);
    const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((entry) => entry.textContent === "Mark all as read")!;
    await act(async () => button.click());
    expect(acknowledgeMany).toHaveBeenCalledTimes(2);
    expect(acknowledgeMany).toHaveBeenNthCalledWith(1, results.slice(0, ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT).map((item) => item.id));
    expect(acknowledgeMany).toHaveBeenNthCalledWith(2, [last.id]);
    expect(document.querySelector("dialog h2")?.textContent).toContain(failLater ? "2" : "1");
    if (failLater) expect(document.querySelector("[role=alert]")?.textContent).toContain("Connection lost");
    expect(button.disabled).toBe(!failLater);
  });
});
