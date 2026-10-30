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

  it("gives only the landing dashboard its full-height section", () => {
    const flags = computeMainViewFlags(baseInput({ landingSelected: true }));
    expect(flags.isLandingView).toBe(true);
    expect(flags.sectionLayoutClassName).toContain("h-full");
    expect(computeMainViewFlags(baseInput({ landingSelected: true, allRunsSelected: true })).isLandingView).toBe(false);
    expect(computeMainViewFlags(baseInput({ hasSelectedProject: false, chatsSelected: true })).isLandingView).toBe(false);
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

  it("uses a fixed flex layout while settings owns the content scroll", () => {
    const flags = computeMainViewFlags(baseInput({ settingsOpen: true }));

    expect(flags.isSettingsView).toBe(true);
    expect(flags.sectionLayoutClassName).toContain("min-h-0");
    expect(flags.sectionLayoutClassName).toContain("flex-1 flex-col");
  });

  it("keeps chat history in a fixed layout without changing chat detail or overlays", () => {
    const flags = computeMainViewFlags(baseInput({ chatsSelected: true }));
    expect(flags.isChatListView).toBe(true);
    expect(flags.sectionLayoutClassName).toContain("min-h-0 min-w-0 flex-1 flex-col");
    expect(computeMainViewFlags(baseInput({ chatsSelected: true, hasChatDetail: true })).isChatListView).toBe(false);
    expect(computeMainViewFlags(baseInput({ chatsSelected: true, settingsOpen: true })).isChatListView).toBe(false);
  });

  it("lets All Runs own its history scroll without leaking its layout into overlays", () => {
    const flags = computeMainViewFlags(baseInput({ allRunsSelected: true }));
    expect(flags.isAllRunsView).toBe(true);
    expect(flags.sectionLayoutClassName).toContain("min-h-0 min-w-0 flex-1 flex-col");
    expect(computeMainViewFlags(baseInput({ allRunsSelected: true, settingsOpen: true })).isAllRunsView).toBe(false);
    expect(computeMainViewFlags(baseInput({ allRunsSelected: true, bookmarksSelected: true })).isAllRunsView).toBe(false);
  });

  it("uses the fixed detail layout only while a bookmark is open", () => {
    const listFlags = computeMainViewFlags(baseInput({ bookmarksSelected: true }));
    const detailFlags = computeMainViewFlags(baseInput({ bookmarksSelected: true, hasBookmarkDetail: true }));

    expect(listFlags.isBookmarkDetailView).toBe(false);
    expect(listFlags.isBookmarkListView).toBe(true);
    expect(listFlags.sectionLayoutClassName).toContain("min-h-0 min-w-0 flex-1 flex-col");
    expect(detailFlags.isBookmarkDetailView).toBe(true);
    expect(detailFlags.isBookmarkListView).toBe(false);
    expect(detailFlags.sectionLayoutClassName).toContain("flex-1 flex-col");
    expect(computeMainViewFlags(baseInput({ bookmarksSelected: true, settingsOpen: true })).isBookmarkListView).toBe(false);
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

  it("moves focus when a different selected run survives in another pane", () => {
    const survivingRunDetail = { run: { id: "surviving-run" } } as SettingsPreviousPageState["runDetail"];
    const state = {
      selectedRunId: "surviving-run",
      runDetail: survivingRunDetail,
      openRunPanes: { left: "deleted-run", right: "surviving-run" },
      focusedRunPane: "left",
      runDetailsById: { "surviving-run": survivingRunDetail },
      selectedChat: null,
      chatDetail: null,
    } as unknown as SettingsPreviousPageState;

    const reconciled = reconcileSettingsPreviousPageAfterModelDeletion(state, ["deleted-run"], []);

    expect(reconciled.selectedRunId).toBe("surviving-run");
    expect(reconciled.focusedRunPane).toBe("right");
  });
});
