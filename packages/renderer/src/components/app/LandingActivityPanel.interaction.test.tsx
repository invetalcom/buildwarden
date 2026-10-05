/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LandingActivityPanel } from "./LandingActivityPanel";

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

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const run = (id: string, createdAt: string, providerAccountId: string) => ({
  id,
  projectId: "project-1",
  providerAccountId,
  modelId: "model-1",
  harnessType: "codex-cli",
  status: "completed",
  inputTokens: 10,
  outputTokens: 0,
  createdAt,
} as unknown as RunRecord);

const account = (id: string, label: string): ProviderAccountRecord => ({
  id, providerType: "codex-cli", label, apiBaseUrl: null, apiKeyRef: "", configJson: "{}", createdAt: "", updatedAt: "",
});

describe("LandingActivityPanel", () => {
  it("switches the chart and provider usage between 7, 14, and 30 day ranges", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <LandingActivityPanel
        runs={[run("recent", daysAgo(0), "recent-account"), run("older", daysAgo(20), "older-account")]}
        providerAccounts={[account("recent-account", "Recent provider"), account("older-account", "Older provider")]}
      />,
    ));

    const rangeButton = (label: string) =>
      [...container!.querySelectorAll<HTMLButtonElement>("[aria-label='Activity range'] button")].find((button) => button.textContent === label)!;
    const dayCount = () => container!.querySelectorAll("[data-activity-day]").length;

    expect(rangeButton("14d").getAttribute("aria-pressed")).toBe("true");
    expect(dayCount()).toBe(14);
    expect(container.textContent).not.toContain("Older provider");

    await act(async () => rangeButton("30d").click());
    expect(rangeButton("30d").getAttribute("aria-pressed")).toBe("true");
    expect(dayCount()).toBe(30);
    expect(container.textContent).toContain("Older provider");
    expect(container.textContent).toContain("2 runs in 30 days");

    await act(async () => rangeButton("7d").click());
    expect(dayCount()).toBe(7);
    expect(container.textContent).toContain("1 run in 7 days");
  });
});
