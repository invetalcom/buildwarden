import { describe, expect, it } from "vitest";
import {
  computeMainViewFlags,
  normalizeProjectFeatureTab,
  reconcileSettingsPreviousPageAfterModelDeletion,
  type MainViewFlagInput,
  type SettingsPreviousPageState,
} from "./app-navigation";

const baseInput = (overrides: Partial<MainViewFlagInput> = {}): MainViewFlagInput => ({
  settingsOpen: false,
  landingSelected: false,
  allRunsSelected: false,
  bookmarksSelected: false,
  chatsSelected: false,
  selectedRunId: null,
  hasSelectedProject: true,
  hasRunDetail: false,
  openRunPaneCount: 0,
  hasChatDetail: false,
  hasBookmarkDetail: false,
  ...overrides,
});

describe("computeMainViewFlags", () => {
  it("uses the landing layout when landing is selected or no project exists", () => {
    expect(computeMainViewFlags(baseInput({ landingSelected: true })).onLandingOrEmptySelection).toBe(true);
    expect(computeMainViewFlags(baseInput({ hasSelectedProject: false })).onLandingOrEmptySelection).toBe(true);
  });

  it("keeps an open run pane in the run-detail layout while detail data is loading", () => {
    const flags = computeMainViewFlags(baseInput({ selectedRunId: "run-1", openRunPaneCount: 1 }));
    expect(flags.isAgentRunDetailView).toBe(true);
    expect(flags.sectionLayoutClassName).toContain("flex-1 flex-col");
  });

  it("selects chat and project layouts without allowing overlay pages to leak through", () => {
    expect(computeMainViewFlags(baseInput({ chatsSelected: true, hasChatDetail: true })).isChatDetailView).toBe(true);
    expect(computeMainViewFlags(baseInput()).isProjectWorkspaceView).toBe(true);
    expect(computeMainViewFlags(baseInput({ settingsOpen: true })).isProjectWorkspaceView).toBe(false);
    expect(computeMainViewFlags(baseInput({ bookmarksSelected: true })).isProjectWorkspaceView).toBe(false);
  });

  it("uses the fixed detail layout only while a bookmark is open", () => {
    const listFlags = computeMainViewFlags(baseInput({ bookmarksSelected: true }));
    const detailFlags = computeMainViewFlags(baseInput({ bookmarksSelected: true, hasBookmarkDetail: true }));

    expect(listFlags.isBookmarkDetailView).toBe(false);
    expect(detailFlags.isBookmarkDetailView).toBe(true);
    expect(detailFlags.sectionLayoutClassName).toContain("flex-1 flex-col");
  });
});

describe("normalizeProjectFeatureTab", () => {
  it.each(["branches", "reviews", "loops"] as const)("redirects folder projects away from the %s tab", (tab) => {
    expect(normalizeProjectFeatureTab("folder", tab)).toBe("overview");
  });

  it("preserves supported folder tabs and all Git project tabs", () => {
    expect(normalizeProjectFeatureTab("folder", "tasks")).toBe("tasks");
    expect(normalizeProjectFeatureTab("git", "reviews")).toBe("reviews");
  });
});

describe("reconcileSettingsPreviousPageAfterModelDeletion", () => {
  it("removes deleted run and chat state while selecting a surviving run pane", () => {
    const deletedRunDetail = { run: { id: "deleted-run" } } as SettingsPreviousPageState["runDetail"];
    const survivingRunDetail = { run: { id: "surviving-run" } } as SettingsPreviousPageState["runDetail"];
    const state = {
      landingSelected: false,
      allRunsSelected: false,
      bookmarksSelected: false,
      chatsSelected: false,
      projectPageTab: "overview",
      selectedBookmark: null,
      selectedChat: { id: "deleted-chat" },
      chatDetail: { chat: { id: "deleted-chat" } },
      selectedRunId: "deleted-run",
      runDetail: deletedRunDetail,
      openRunPanes: { left: "deleted-run", right: "surviving-run" },
      focusedRunPane: "left",
      runDetailsById: {
        "deleted-run": deletedRunDetail,
        "surviving-run": survivingRunDetail,
      },
    } as unknown as SettingsPreviousPageState;

    const reconciled = reconcileSettingsPreviousPageAfterModelDeletion(
      state,
      ["deleted-run"],
      ["deleted-chat"],
    );
    expect(reconciled).toMatchObject({
      selectedChat: null,
      chatDetail: null,
      selectedRunId: "surviving-run",
      runDetail: survivingRunDetail,
      focusedRunPane: "right",
    });
    expect(reconciled.openRunPanes).toEqual({ right: "surviving-run" });
    expect(reconciled.runDetailsById).toEqual({ "surviving-run": survivingRunDetail });
  });
});
