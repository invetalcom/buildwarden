/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunPlanProgressPill } from "./RunPlanProgressPill";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("RunPlanProgressPill", () => {
  it("uses primary colors for the summary and active plan step", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunPlanProgressPill
        progress={{
          stepId: "step-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          fallback: false,
          previousTurn: false,
          explanation: "Quality plan",
          source: "codex",
          steps: [
            { title: "Inspect", status: "completed" },
            { title: "Refactor", status: "inProgress" },
            { title: "Verify", status: "pending" },
          ],
        }}
      />,
    ));

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.className).toContain("bg-[var(--ec-accent-soft)]");
    expect(trigger.className).not.toContain("--ec-info");

    await act(async () => trigger.click());

    const activeTitle = [...document.body.querySelectorAll("p")].find((element) => element.textContent === "Refactor")!;
    const activeRow = activeTitle.parentElement!.parentElement!;
    const activeIcon = activeRow.querySelector("span")!;
    expect(activeRow.className).toContain("bg-[var(--ec-accent-soft)]");
    expect(activeIcon.className).toContain("text-[var(--ec-accent)]");
    expect(activeRow.className).not.toContain("--ec-info");
  });

  it("marks an unfinished plan from the previous prompt as inactive", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunPlanProgressPill
        compact
        progress={{
          stepId: "step-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          fallback: false,
          previousTurn: true,
          source: "claude",
          steps: [
            { title: "Inspect", status: "completed" },
            { title: "Refactor", status: "inProgress" },
          ],
        }}
      />,
    ));

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.textContent).toContain("Prev. plan");
    expect(trigger.className).toContain("opacity-60");

    await act(async () => trigger.click());

    expect(document.body.textContent).toContain("Previous prompt's plan");
    expect(document.body.textContent).toContain("unfinished");
    expect(document.body.querySelector(".animate-spin")).toBeNull();
  });
});
