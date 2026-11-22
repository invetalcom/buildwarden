/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RefreshCw } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentWorkingIndicator } from "./agent-working-indicator";
import { Badge } from "./badge";
import { LiveDot, LoadingBar, Spinner, StatusDot } from "./motion";

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

const render = async (node: React.ReactNode): Promise<HTMLDivElement> => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
};

describe("activity indicators", () => {
  it("renders the spinner as the rotating icon it always was, with a hook for themes", async () => {
    const host = await render(<Spinner className="size-4 text-red-500" aria-hidden />);
    const spinner = host.querySelector('svg[data-ui="spinner"]')!;
    expect(spinner.classList.contains("animate-spin")).toBe(true);
    expect(spinner.classList.contains("size-4")).toBe(true);
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    // Themes hide the drawing and paint the element, so the drawing must be the element's children.
    expect(spinner.children.length).toBeGreaterThan(0);
  });

  it("shows another glyph as itself until it spins", async () => {
    const host = await render(<><Spinner icon={RefreshCw} spinning={false} className="size-3" /><Spinner icon={RefreshCw} spinning className="size-5" /></>);
    const [idle, busy] = [...host.querySelectorAll("svg")];
    expect(idle!.hasAttribute("data-ui")).toBe(false);
    expect(idle!.classList.contains("animate-spin")).toBe(false);
    expect(busy!.getAttribute("data-ui")).toBe("spinner");
    expect(busy!.classList.contains("animate-spin")).toBe(true);
  });

  it("marks dots and bars with their hook and state, and leaves their look to the caller", async () => {
    const host = await render(<>
      <StatusDot state="failed" className="size-1.5 rounded-full" />
      <LiveDot active className="running-pulse" />
      <LiveDot active={false} className="idle" />
      <LoadingBar className="mb-2" />
    </>);
    const status = host.querySelector('[data-ui="status-dot"]')!;
    expect(status.getAttribute("data-state")).toBe("failed");
    expect(status.className).toBe("size-1.5 rounded-full");
    expect(host.querySelector('[data-ui="live-dot"][data-active="true"]')!.className).toBe("running-pulse");
    expect(host.querySelector('[data-ui="live-dot"][data-active="false"]')!.className).toBe("idle");
    expect(host.querySelector('[data-ui="loading-bar"]')!.className).toBe("run-activity-loading-bar mb-2");
    for (const element of host.querySelectorAll("[data-ui]")) expect(element.getAttribute("aria-hidden")).toBe("true");
  });

  it("builds the working block from the shared bar and spinner", async () => {
    const host = await render(<AgentWorkingIndicator label="Thinking" />);
    const block = host.querySelector('[data-ui="working"]')!;
    expect(block.getAttribute("role")).toBe("status");
    expect(block.querySelector(':scope > [data-ui="loading-bar"]')).not.toBeNull();
    expect(block.querySelector('[data-ui="working-row"] > [data-ui="spinner"]')).not.toBeNull();
    expect(block.querySelector('[data-ui="working-label"]')!.textContent).toBe("Thinking");
  });

  it("gives a badge's dot the live-dot hook, active only for a running badge", async () => {
    const host = await render(<><Badge tone="running" dot>Running</Badge><Badge tone="completed" dot>Done</Badge></>);
    const dots = [...host.querySelectorAll('[data-ui="badge"] [data-ui="live-dot"]')];
    expect(dots.map((dot) => dot.getAttribute("data-active"))).toEqual(["true", "false"]);
    expect(dots[0]!.classList.contains("running-pulse")).toBe(true);
    expect(dots[1]!.classList.contains("running-pulse")).toBe(false);
  });
});
