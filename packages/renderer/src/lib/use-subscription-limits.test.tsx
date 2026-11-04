/** @vitest-environment happy-dom */
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, SubscriptionLimitsReport, SubscriptionProvider } from "@buildwarden/shared";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./buildwarden-client-core";
import { BuildWardenClientProvider } from "./buildwarden-client";
import { useSubscriptionLimitsStartup } from "./use-subscription-limits";
import { LandingPage, type HomeTab } from "../components/app/LandingPage";
import { LimitsPage } from "../components/app/LimitsPage";
import { TitleBarLimits } from "../components/app/TitleBarLimits";
import { EMPTY_SNAPSHOT } from "../components/app/app-model";

let root: Root;
let container: HTMLDivElement;
const report: SubscriptionLimitsReport = { accounts: [{ id: "codex", providerType: "codex-cli", label: "Codex", status: "fresh", checkedAt: new Date().toISOString(), windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 40 }] }] };
beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

function Home({ client }: { client: BuildWardenClient }) {
  const available = useSubscriptionLimitsStartup(client, "providers");
  const [tab, setTab] = useState<HomeTab>("overview");
  return <BuildWardenClientProvider client={client}>
    {available ? <TitleBarLimits client={client} onOpenLimits={() => setTab("limits")} /> : null}
    <LandingPage snapshot={EMPTY_SNAPSHOT} sessionJoke="Ready" onSelectProject={vi.fn()} onSelectRun={vi.fn()}
      tab={tab} onTabChange={setTab} limitsPanel={available ? <LimitsPage /> : null} />
  </BuildWardenClientProvider>;
}
async function render(installed: SubscriptionProvider[]) {
  const getSubscriptionLimitsAvailability = vi.fn(async () => installed);
  const getSubscriptionLimits = vi.fn(async () => report);
  const client = createElectronBuildWardenClient({ getSubscriptionLimitsAvailability, getSubscriptionLimits } as unknown as DesktopApi);
  await act(async () => root.render(<StrictMode><Home client={client} /></StrictMode>));
  return { getSubscriptionLimitsAvailability, getSubscriptionLimits };
}
const click = async (selector: string) => { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()); };

describe("subscription limits startup and entry points", () => {
  it("hides the tab, page, and title-bar icon and skips probes when no providers are installed", async () => {
    const { getSubscriptionLimits } = await render([]);
    expect(document.querySelector("#home-tab-limits")).toBeNull();
    expect(document.querySelector("#home-panel-limits")).toBeNull();
    expect(document.querySelector('[aria-label="Subscription limits"]')).toBeNull();
    expect(getSubscriptionLimits).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Recent runs");
  });
  it("warms the cache at startup and shows it immediately while a newly opened page refreshes", async () => {
    const { getSubscriptionLimits } = await render(["codex-cli"]);
    expect(getSubscriptionLimits).toHaveBeenCalledExactlyOnceWith({ refresh: true });
    let finish!: (result: SubscriptionLimitsReport) => void;
    getSubscriptionLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("#home-tab-limits");
    expect(getSubscriptionLimits).toHaveBeenCalledTimes(2);
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: true });
    expect(container.textContent).toContain("60% left");
    expect(container.textContent).not.toContain("Reading provider limits");
    await act(async () => finish(report));
    await click("#home-tab-overview");
    await click("#home-tab-limits");
    expect(getSubscriptionLimits).toHaveBeenCalledTimes(3);
  });
  it("shares the startup reading with the popup and refreshes on every reopen", async () => {
    const { getSubscriptionLimits } = await render(["codex-cli"]);
    let finish!: (result: SubscriptionLimitsReport) => void;
    getSubscriptionLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click('[aria-label="Subscription limits"]');
    expect(document.querySelector("dialog")?.textContent).toContain("60% left");
    expect(getSubscriptionLimits).toHaveBeenCalledTimes(2);
    await act(async () => finish(report));
    await click('[aria-label="Close limits"]');
    await click('[aria-label="Subscription limits"]');
    expect(getSubscriptionLimits).toHaveBeenCalledTimes(3);
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: true });
  });
  it("reveals the entry points after a provider is installed while BuildWarden is running", async () => {
    const { getSubscriptionLimitsAvailability, getSubscriptionLimits } = await render([]);
    getSubscriptionLimitsAvailability.mockResolvedValue(["codex-cli"]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(document.querySelector("#home-tab-limits")).not.toBeNull();
    expect(document.querySelector('[aria-label="Subscription limits"]')).not.toBeNull();
    expect(getSubscriptionLimits).toHaveBeenCalledOnce();
  });
});
