/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FollowUpQueueAction, QueuedFollowUpRecord } from "@buildwarden/shared";
import { FollowUpQueuePanel } from "./FollowUpQueuePanel";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const entry = (id: string, prompt: string, extra: Partial<QueuedFollowUpRecord> = {}): QueuedFollowUpRecord => ({
  id, runId: "run-1", chatId: null, position: 1, prompt, modelId: null, mode: null, updatesGoal: false,
  attachments: [], createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z", ...extra,
});

const render = async (props: Partial<Parameters<typeof FollowUpQueuePanel>[0]> = {}) => {
  const onAction = vi.fn<(action: FollowUpQueueAction) => Promise<void>>(async () => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <FollowUpQueuePanel
      queue={[entry("a", "First"), entry("b", "Second", { attachments: [{ fileName: "x.png", mimeType: "image/png", sizeBytes: 3 }] })]}
      active
      steeringAvailable={false}
      onAction={onAction}
      {...props}
    />,
  ));
  const button = (label: string, index = 0) => container!.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index]!;
  return { onAction, button };
};

describe("FollowUpQueuePanel", () => {
  it("lists entries in order and sends reorder, remove, and steer actions", async () => {
    const { onAction, button } = await render({ steeringAvailable: true });
    expect(container!.textContent).toContain("Queued · 2");
    expect(container!.querySelectorAll("li")).toHaveLength(2);
    expect(button("Move up", 0).disabled).toBe(true);
    expect(button("Move down", 1).disabled).toBe(true);

    await act(async () => button("Move up", 1).click());
    await act(async () => button("Remove queued follow-up", 0).click());
    await act(async () => button("Steer into the running turn now", 1).click());
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      { type: "move", queuedFollowUpId: "b", direction: "up" },
      { type: "delete", queuedFollowUpId: "a" },
      { type: "send-now", queuedFollowUpId: "b" },
    ]);
  });

  it("edits an entry in place", async () => {
    const { onAction, button } = await render();
    await act(async () => button("Edit queued follow-up", 0).click());
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("First");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "First, revised");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save queued follow-up").click());
    expect(onAction).toHaveBeenCalledWith({ type: "edit", queuedFollowUpId: "a", prompt: "First, revised" });
    expect(container!.querySelector("textarea")).toBeNull();
  });

  it("offers resume when the queue is held", async () => {
    const { onAction } = await render({ active: false });
    expect(container!.textContent).toContain("Held");
    const resume = [...container!.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Resume"))!;
    await act(async () => resume.click());
    expect(onAction).toHaveBeenCalledWith({ type: "resume" });
  });
});
