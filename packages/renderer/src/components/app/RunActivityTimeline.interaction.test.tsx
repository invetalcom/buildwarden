/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunToolCallCollapseThresholdProvider } from "../../lib/run-tool-call-collapse-settings";
import { RunActivityTimeline } from "./RunActivityTimeline";
import type { RunActivityStep } from "./run-activity-model";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
type ResizeRegistration = { callback: ResizeObserverCallback; observer: ResizeObserver };
const resizeRegistrations = new Map<Element, ResizeRegistration[]>();

const emitResize = (target: Element, height: number) => {
  if (target instanceof HTMLElement) target.dataset.testHeight = String(height);
  const entry = {
    target,
    contentRect: new DOMRectReadOnly(0, 0, 1_000, height),
    borderBoxSize: [{ inlineSize: 1_000, blockSize: height }],
    contentBoxSize: [{ inlineSize: 1_000, blockSize: height }],
    devicePixelContentBoxSize: [{ inlineSize: 1_000, blockSize: height }],
  };
  for (const registration of resizeRegistrations.get(target) ?? []) {
    registration.callback([entry], registration.observer);
  }
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return Number(this.dataset.testHeight) || (this.classList.contains("agent-virtual-row") ? 52 : 600);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1_000;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = Number(this.dataset.testHeight) || (this.classList.contains("agent-virtual-row") ? 52 : 600);
    return new DOMRect(0, 0, 1_000, height);
  };
  globalThis.ResizeObserver = class TestResizeObserver implements ResizeObserver {
    private readonly targets = new Set<Element>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      resizeRegistrations.set(target, [
        ...(resizeRegistrations.get(target) ?? []),
        { callback: this.callback, observer: this },
      ]);
      const height = target.classList.contains("agent-virtual-row") ? 52 : 600;
      emitResize(target, height);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
      resizeRegistrations.set(
        target,
        (resizeRegistrations.get(target) ?? []).filter((registration) => registration.observer !== this),
      );
    }
    disconnect() {
      for (const target of this.targets) this.unobserve(target);
    }
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  resizeRegistrations.clear();
});

const step = (
  id: string,
  eventType: RunActivityStep["eventType"],
  metadata: Record<string, unknown>,
): RunActivityStep => ({
  id,
  eventType,
  title: id,
  content: "",
  metadataJson: JSON.stringify(metadata),
  createdAt: "2026-08-16T10:00:00.000Z",
});

const toolStreak = ["a.ts", "b.ts", "c.ts", "d.ts"].flatMap((path, index) => [
  step(`call-${String(index)}`, "tool-call", { callId: String(index), toolName: "read_file", path }),
  step(`result-${String(index)}`, "tool-result", { callId: String(index), toolName: "read_file", path, ok: true }),
]);

describe("run activity tool-call collapse interaction", () => {
  it("expands inside the same TanStack virtual row and can collapse again", async () => {
    container = document.createElement("div");
    container.style.height = "600px";
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <RunToolCallCollapseThresholdProvider threshold={2}>
          <RunActivityTimeline
            steps={toolStreak}
            run={{ id: "virtual-tool-streak", status: "completed", mode: "code" }}
            className="h-[600px] overflow-y-auto"
            virtualized
            initialScrollPosition="start"
          />
        </RunToolCallCollapseThresholdProvider>,
      );
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Expand 4 consecutive tool calls"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    const virtualRow = toggle?.closest<HTMLElement>(".agent-virtual-row") ?? null;
    expect(virtualRow?.dataset.index).toBe("0");
    expect(container.textContent).not.toContain("a.ts");
    const virtualSpacer = container.querySelector<HTMLElement>(".agent-virtual-spacer");
    const collapsedSpacerHeight = virtualSpacer?.style.height;

    await act(async () => toggle?.click());
    const collapseToggle = container.querySelector<HTMLButtonElement>('[aria-label="Collapse 4 consecutive tool calls"]');
    expect(collapseToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(collapseToggle?.closest(".agent-virtual-row")).toBe(virtualRow);
    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).toContain("d.ts");
    await act(async () => {
      if (virtualRow) emitResize(virtualRow, 220);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(virtualSpacer?.style.height).not.toBe(collapsedSpacerHeight);

    await act(async () => collapseToggle?.click());
    expect(container.querySelector('[aria-label="Expand 4 consecutive tool calls"]')).not.toBeNull();
    expect(container.textContent).not.toContain("a.ts");
  });
});
