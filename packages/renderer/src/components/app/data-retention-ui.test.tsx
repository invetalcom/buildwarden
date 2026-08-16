/** @vitest-environment happy-dom */

import {
  DEFAULT_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD,
  MAX_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD,
  MIN_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD,
  parseConsecutiveToolCallCollapseThresholdSetting,
  type DataRetentionCleanupImpact,
} from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DataRetentionSettingsControl,
  PastedTextAttachmentThresholdControl,
  ToolCallCollapseThresholdControl,
} from "./settings-git-workspace-tab";
import { StartupDataRetentionDialog } from "./StartupDataRetentionDialog";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const render = async (component: React.ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(component));
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const impact: DataRetentionCleanupImpact = {
  dayCount: 30,
  cutoffAt: "2026-07-10T00:00:00.000Z",
  runIds: ["run-1", "run-2", "run-3"],
  chatIds: ["chat-1", "chat-2"],
  projectLabThreadIds: ["lab-1"],
  projectLoopIds: ["loop-1", "loop-2", "loop-3", "loop-4"],
  runCount: 3,
  chatCount: 2,
  projectLabThreadCount: 1,
  projectLoopCount: 4,
};

describe("data-retention settings and startup review", () => {
  it("keeps the day field hidden while disabled and enables the policy explicitly", async () => {
    const onEnabledChange = vi.fn();
    await render(
      <DataRetentionSettingsControl
        busy={false}
        enabled={false}
        dayCount={30}
        onEnabledChange={onEnabledChange}
        onDayCountChange={vi.fn()}
      />,
    );

    expect(container?.querySelector('input[aria-label="Old data retention days"]')).toBeNull();
    const toggle = container?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle?.click());
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("saves a valid whole-day threshold and rejects invalid values", async () => {
    const onDayCountChange = vi.fn<(value: number) => Promise<void>>().mockResolvedValue();
    await render(
      <DataRetentionSettingsControl
        busy={false}
        enabled
        dayCount={30}
        onEnabledChange={vi.fn()}
        onDayCountChange={onDayCountChange}
      />,
    );

    const input = container?.querySelector<HTMLInputElement>('input[aria-label="Old data retention days"]');
    await act(async () => {
      if (!input) return;
      setInputValue(input, "90");
    });
    const save = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === "Save");
    await act(async () => save?.click());
    expect(onDayCountChange).toHaveBeenCalledWith(90);

    await act(async () => {
      if (!input) return;
      setInputValue(input, "0");
    });
    expect(container?.textContent).toContain("Enter a whole number");
    expect(input?.getAttribute("aria-describedby")).toBe("data-retention-days-error");
    expect(container?.querySelector("#data-retention-days-error")).not.toBeNull();
    expect(save?.disabled).toBe(true);
  });

  it("shows grouped deletion counts and requires explicit confirmation", async () => {
    const onConfirm = vi.fn();
    const onSkip = vi.fn();
    await render(
      <StartupDataRetentionDialog
        state={{ status: "review", impact }}
        onConfirm={onConfirm}
        onSkip={onSkip}
        onRetry={vi.fn()}
      />,
    );

    expect(container?.textContent).toContain("Agent runs");
    expect(container?.textContent).toContain("Project Lab threads");
    expect(container?.textContent).toContain("Bookmarked runs and chats");
    const deleteButton = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.includes("Delete old data"));
    await act(async () => deleteButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("allows retrying or skipping after a startup retention error", async () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    await render(
      <StartupDataRetentionDialog
        state={{ status: "error", phase: "checking", message: "Snapshot unavailable" }}
        onConfirm={vi.fn()}
        onSkip={onSkip}
        onRetry={onRetry}
      />,
    );

    const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    await act(async () => buttons.find((button) => button.textContent?.includes("Retry check"))?.click());
    await act(async () => buttons.find((button) => button.textContent?.includes("Continue to app"))?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("disables both actions while old data is being deleted", async () => {
    const onConfirm = vi.fn();
    const onSkip = vi.fn();
    await render(
      <StartupDataRetentionDialog
        state={{ status: "deleting", impact }}
        onConfirm={onConfirm}
        onSkip={onSkip}
        onRetry={vi.fn()}
      />,
    );

    const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const skipButton = buttons.find((button) => button.textContent?.includes("Not now"));
    const deleteButton = buttons.find((button) => button.textContent?.includes("Deleting old data"));
    expect(skipButton?.disabled).toBe(true);
    expect(deleteButton?.disabled).toBe(true);
    await act(async () => skipButton?.click());
    await act(async () => deleteButton?.click());
    expect(onSkip).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("pasted-text attachment threshold settings", () => {
  it("auto-saves a valid threshold and rejects values outside the supported range", async () => {
    vi.useFakeTimers();
    const onThresholdChange = vi.fn<(value: number) => Promise<void>>().mockResolvedValue();
    await render(
      <PastedTextAttachmentThresholdControl
        busy={false}
        threshold={2_000}
        onThresholdChange={onThresholdChange}
      />,
    );

    const input = container?.querySelector<HTMLInputElement>('input[aria-label="Pasted text attachment threshold"]');
    await act(async () => {
      if (!input) return;
      setInputValue(input, "3500");
    });
    expect(container?.querySelector("button")).toBeNull();
    expect(container?.textContent).not.toContain("Use default");
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(onThresholdChange).toHaveBeenCalledWith(3_500);

    await act(async () => {
      if (!input) return;
      setInputValue(input, "0");
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(container?.textContent).toContain("Enter a whole number");
    expect(input?.getAttribute("aria-describedby")).toBe("pasted-text-attachment-threshold-error");
    expect(onThresholdChange).toHaveBeenCalledTimes(1);
  });
});

describe("consecutive tool-call collapse threshold settings", () => {
  it("normalizes missing, low, and high persisted values", () => {
    expect(parseConsecutiveToolCallCollapseThresholdSetting(undefined)).toBe(DEFAULT_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD);
    expect(parseConsecutiveToolCallCollapseThresholdSetting("0")).toBe(MIN_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD);
    expect(parseConsecutiveToolCallCollapseThresholdSetting("1001")).toBe(MAX_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD);
  });

  it("auto-saves a valid threshold and rejects values outside the supported range", async () => {
    vi.useFakeTimers();
    const onThresholdChange = vi.fn<(value: number) => Promise<void>>().mockResolvedValue();
    await render(
      <ToolCallCollapseThresholdControl
        busy={false}
        threshold={DEFAULT_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD}
        onThresholdChange={onThresholdChange}
      />,
    );

    const input = container?.querySelector<HTMLInputElement>('input[aria-label="Consecutive tool call collapse threshold"]');
    await act(async () => {
      if (!input) return;
      setInputValue(input, "8");
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(onThresholdChange).toHaveBeenCalledWith(8);

    await act(async () => {
      if (!input) return;
      setInputValue(input, "1001");
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(input?.getAttribute("aria-describedby")).toBe("tool-call-collapse-threshold-error");
    expect(container?.textContent).toContain("Enter a whole number");
    expect(onThresholdChange).toHaveBeenCalledTimes(1);
  });
});
