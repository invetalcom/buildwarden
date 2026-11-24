/** @vitest-environment happy-dom */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AttentionItem, DesktopApi, HomeLayout, RunEvent } from "@buildwarden/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { EMPTY_SNAPSHOT } from "./app-model";
import { LandingPage } from "./LandingPage";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => { vi.useFakeTimers(); });

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

type Props = Partial<ComponentProps<typeof LandingPage>>;

const mount = async (api: Partial<DesktopApi>, props: Props = {}) => {
  const client = createElectronBuildWardenClient(api as DesktopApi);
  const element = (next: Props) => (
    <BuildWardenClientProvider client={client}>
      <LandingPage snapshot={EMPTY_SNAPSHOT} sessionJoke="Ready" onSelectProject={vi.fn()} onSelectRun={vi.fn()} {...props} {...next} />
    </BuildWardenClientProvider>
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element({})));
  return { rerender: (next: Props) => act(async () => root!.render(element(next))) };
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
};

const summary = () => container!.querySelector('[data-section="summary"]')!.textContent;

const lanes = () => [...container!.querySelectorAll<HTMLElement>('[data-ui="home-chart-lane"]')].map((lane) => lane.dataset.metric);
const chip = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('[aria-label="Chart metrics"] button')].find((button) => button.textContent?.startsWith(label))!;

describe("LandingPage chart choices", () => {
  it("shows a choice at once and keeps it while it is being saved", async () => {
    const onLayoutChange = vi.fn<(layout: HomeLayout) => Promise<void>>(() => new Promise(() => undefined));
    await mount({}, { onLayoutChange });

    await act(async () => chip("Tokens").click());
    expect(lanes()).toEqual(["runs"]);
    expect(onLayoutChange.mock.lastCall![0].chart.metrics).toEqual(["runs", "cost"]);
  });

  it("goes back to the saved chart when the save fails", async () => {
    const onLayoutChange = vi.fn<(layout: HomeLayout) => Promise<void>>().mockRejectedValue(new Error("disk full"));
    await mount({}, { onLayoutChange });

    await act(async () => chip("Tokens").click());
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect(lanes()).toEqual(["runs", "tokens"]);
  });
});

describe("LandingPage waiting requests", () => {
  it("keeps the newest inbox answer when an older one arrives after it", async () => {
    const first = deferred<AttentionItem[]>();
    const second = deferred<AttentionItem[]>();
    const getAttentionInbox = vi.fn<() => Promise<AttentionItem[]>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let publish: (event: RunEvent) => void = () => undefined;
    const onRunEvent = vi.fn((listener: (event: RunEvent) => void) => { publish = listener; return () => undefined; });
    await mount({ getAttentionInbox, onRunEvent } as unknown as Partial<DesktopApi>);

    // A resolved approval starts a second request while the first is still on its way.
    await act(async () => { publish({ type: "approval-resolved" } as RunEvent); await vi.advanceTimersByTimeAsync(1_000); });
    expect(getAttentionInbox).toHaveBeenCalledTimes(2);

    await act(async () => { second.resolve([]); await Promise.resolve(); });
    expect(summary()).toContain("Nothing is waiting for you.");
    await act(async () => { first.resolve([{ id: "old", kind: "approval" } as AttentionItem]); await Promise.resolve(); });
    expect(summary()).toContain("Nothing is waiting for you.");
  });
});
