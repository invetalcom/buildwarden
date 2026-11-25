import { DEFAULT_HOME_LAYOUT, type AppSnapshot, type HomeLayout, type RunRecord } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { LandingPage } from "./LandingPage";

const run = (id: string, minutesAgo: number, overrides: Partial<RunRecord> = {}) => ({
  id,
  projectId: "project-1",
  providerAccountId: "account-1",
  modelId: "model-1",
  harnessType: "codex-cli",
  status: "completed",
  prompt: `Prompt ${id}`,
  inputTokens: 10,
  outputTokens: 5,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  ...overrides,
} as RunRecord);

const snapshot = {
  projects: [{
    project: {
      id: "project-1",
      name: "BuildWarden",
      repoPath: "C:/repo",
      baseBranch: "main",
      kind: "git",
      cumulativeInputTokens: 80,
      cumulativeOutputTokens: 20,
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-31T10:00:00.000Z",
      lastOpenedAt: "2026-08-31T10:00:00.000Z",
    },
    runs: [],
    forLaterRuns: [],
    orchestratedRuns: [],
    activeRuns: [],
    recentRuns: [],
    tasks: [],
    automations: [],
    insights: [],
    labThreads: [],
    loops: [],
  }],
  providerAccounts: [],
  models: [],
  selectedProjectId: null,
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
  tokenUsage: {
    standaloneChats: { inputTokens: 15, outputTokens: 10 },
    today: { inputTokens: 40, outputTokens: 15 },
  },
} satisfies AppSnapshot;

const withRuns = (runs: RunRecord[]): AppSnapshot => ({ ...snapshot, projects: [{ ...snapshot.projects[0]!, runs }] });

const render = (props: Partial<Parameters<typeof LandingPage>[0]> = {}) => renderToStaticMarkup(
  <LandingPage snapshot={snapshot} sessionJoke="Ready" onSelectProject={vi.fn()} onSelectRun={vi.fn()} {...props} />,
);

const layout = (patch: Partial<HomeLayout>): HomeLayout => ({ ...DEFAULT_HOME_LAYOUT, ...patch });

describe("LandingPage token usage", () => {
  it("includes standalone chats in lifetime usage and ledger usage in today's activity", () => {
    const markup = render();

    expect(markup).toContain("125");
    expect(markup).toContain("55 tokens today");
  });
});

describe("LandingPage tabs", () => {
  it("shows Limits independently of usage cost tracking", () => {
    const markup = render({ tab: "limits", onTabChange: vi.fn(), usagePanel: null, limitsPanel: <p>provider limits</p> });
    expect(markup).toContain('id="home-tab-limits"');
    expect(markup).toContain('id="home-panel-limits"');
    expect(markup).toContain("provider limits");
    expect(markup).not.toContain('id="home-tab-usage"');
    expect(markup).not.toContain('data-ui="home-section"');
  });

  it("hides the Usage tab and shows lifetime tokens while cost tracking is off", () => {
    const markup = render({ tab: "usage", onTabChange: vi.fn(), usagePanel: null });

    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("est. cost");
    expect(markup).toContain("tokens · all time");
    expect(markup).toContain('data-ui="home-section"');
  });

  it("shows the usage dashboard in place of the overview on the Usage tab", () => {
    const markup = render({ tab: "usage", onTabChange: vi.fn(), usagePanel: <p>usage dashboard</p> });

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("usage dashboard");
    expect(markup).not.toContain('data-ui="home-section"');
    expect(markup).toContain("Ready");
  });

  it("swaps lifetime tokens for the cost summary on the overview while tracking is on", () => {
    const markup = render({ tab: "overview", onTabChange: vi.fn(), usagePanel: <p>usage dashboard</p> });

    expect(markup).toContain("est. cost · 30 days");
    expect(markup).not.toContain("tokens · all time");
    expect(markup).not.toContain("usage dashboard");
  });
});

describe("LandingPage layout", () => {
  it("shows the default sections in order, with the chart after them", () => {
    const markup = render();
    const order = ['data-section="greeting"', 'data-section="summary"', 'data-section="stats"', 'data-section="runs"', 'data-ui="home-chart"'].map((part) => markup.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).not.toContain('data-section="projects"');
    expect(markup).not.toContain('data-section="providers"');
  });

  it("follows the sections, their order and the greeting text of the layout", () => {
    const markup = render({ layout: layout({ sections: ["projects", "greeting"], greetingText: "Welcome back" }) });

    expect(markup.indexOf('data-section="projects"')).toBeLessThan(markup.indexOf('data-section="greeting"'));
    expect(markup).toContain("Welcome back");
    expect(markup).not.toContain('data-section="stats"');
    expect(markup).not.toContain('data-section="summary"');
  });

  it("shows only the figures the layout lists and leaves out a repeated token total", () => {
    const markup = render({ layout: layout({ stats: ["waiting", "cost", "tokens"] }) });

    expect(markup).toContain('data-stat="waiting"');
    expect(markup).toContain('data-stat="cost"');
    expect(markup).not.toContain('data-stat="tokens"');
    expect(markup).not.toContain('data-stat="running"');
  });

  it("limits the recent runs to the number of rows of the layout", () => {
    const runs = [run("a", 1), run("b", 2), run("c", 3), run("d", 4)];

    const three = render({ snapshot: withRuns(runs) });
    expect(three).toContain("Prompt c");
    expect(three).not.toContain("Prompt d");
    expect(render({ snapshot: withRuns(runs), layout: layout({ recentRuns: 1 }) })).not.toContain("Prompt b");
  });

  it("hides the boot message and the chart when the layout turns them off", () => {
    const markup = render({ layout: layout({ bootMessage: false, chart: { ...DEFAULT_HOME_LAYOUT.chart, show: false } }) });

    expect(markup).not.toContain('data-ui="home-boot"');
    expect(markup).not.toContain("Ready");
    expect(markup).not.toContain('data-ui="home-chart"');
  });

  it("offers the cost lane only while cost tracking is on", () => {
    expect(render()).not.toContain('data-metric="cost"');
    const tracked = render({ tab: "overview", onTabChange: vi.fn(), usagePanel: <p>usage dashboard</p> });
    expect(tracked).toContain('data-metric="cost"');
  });

  it("keeps showing runs when the layout asks only for a lane without data", () => {
    const markup = render({ layout: layout({ chart: { ...DEFAULT_HOME_LAYOUT.chart, metrics: ["cost"] } }) });

    expect(markup).toContain('data-metric="runs"');
    expect(markup).not.toContain('data-metric="tokens"');
  });
});
