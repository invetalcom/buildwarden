/** @vitest-environment happy-dom */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AttentionItem, DesktopApi, HomeLayout, RunEvent, UsageCostReport } from "@buildwarden/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { EMPTY_SNAPSHOT } from "./app-model";
import { LandingPage } from "./LandingPage";
import { formatUsd } from "./usage-analytics";

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

  it("keeps the newest choice on screen when the save of an earlier one finishes first", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const onLayoutChange = vi.fn<(layout: HomeLayout) => Promise<void>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = await mount({}, { onLayoutChange });

    await act(async () => chip("Tokens").click());
    await act(async () => chip("Tokens").click());
    expect(lanes()).toEqual(["runs", "tokens"]);
    const [[firstSaved], [secondSaved]] = onLayoutChange.mock.calls;
    expect(firstSaved.chart.metrics).toEqual(["runs", "cost"]);

    // The first save arrives as the saved layout while the second is still on its way.
    await rerender({ layout: firstSaved });
    await act(async () => { first.resolve(); await Promise.resolve(); });
    expect(lanes()).toEqual(["runs", "tokens"]);

    await rerender({ layout: secondSaved });
    await act(async () => { second.resolve(); await Promise.resolve(); });
    expect(lanes()).toEqual(["runs", "tokens"]);
    // From here on the saved layout decides again.
    await rerender({ layout: firstSaved });
    expect(lanes()).toEqual(["runs"]);
  });
});

describe("LandingPage cost report", () => {
  const todayKey = () => {
    const now = new Date();
    return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const report = (costUsd: number): UsageCostReport => ({
    generatedAt: new Date().toISOString(),
    rangeDays: 30,
    bucketSize: "day",
    buckets: [todayKey()],
    previousBuckets: [],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    models: [{ providerType: "codex-cli", modelId: "gpt-5", rates: null, matchedKey: null, colorRank: 0 }],
    projects: [{ projectId: null, name: "Chats", colorRank: 0 }],
    rows: [{
      bucket: todayKey(), modelIndex: 0, projectIndex: 0, cacheSavingsUsd: 0,
      tokens: { inputTokens: 100, uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      cost: { input: costUsd, cacheRead: 0, cacheWrite: 0, output: 0 },
    }],
  });
  const withTokensToday = (tokens: number) => ({ ...EMPTY_SNAPSHOT, tokenUsage: { standaloneChats: { inputTokens: 0, outputTokens: 0 }, today: { inputTokens: tokens, outputTokens: 0 } } });
  const tracked = { tab: "overview" as const, onTabChange: vi.fn(), usagePanel: <p>usage</p> };

  it("loads the report again after usage changed, once for changes that come close together", async () => {
    const getUsageCostReport = vi.fn<() => Promise<UsageCostReport>>().mockResolvedValueOnce(report(1)).mockResolvedValueOnce(report(2));
    const { rerender } = await mount({ getUsageCostReport } as unknown as Partial<DesktopApi>, { ...tracked, snapshot: withTokensToday(100) });
    expect(chip("Cost").textContent).toBe(`Cost${formatUsd(1)}`);

    await rerender({ snapshot: withTokensToday(200) });
    await rerender({ snapshot: withTokensToday(300) });
    expect(getUsageCostReport).toHaveBeenCalledTimes(1);
    // The loaded report stays on screen while the page waits to ask again.
    expect(chip("Cost").textContent).toBe(`Cost${formatUsd(1)}`);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getUsageCostReport).toHaveBeenCalledTimes(2);
    expect(chip("Cost").textContent).toBe(`Cost${formatUsd(2)}`);
  });

  it("does not ask again while usage stays the same, and keeps the report when a refresh fails", async () => {
    const getUsageCostReport = vi.fn<() => Promise<UsageCostReport>>().mockResolvedValueOnce(report(1)).mockRejectedValueOnce(new Error("offline"));
    const { rerender } = await mount({ getUsageCostReport } as unknown as Partial<DesktopApi>, { ...tracked, snapshot: withTokensToday(100) });

    await rerender({ snapshot: withTokensToday(100) });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getUsageCostReport).toHaveBeenCalledTimes(1);

    await rerender({ snapshot: withTokensToday(200) });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getUsageCostReport).toHaveBeenCalledTimes(2);
    expect(chip("Cost").textContent).toBe(`Cost${formatUsd(1)}`);
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
