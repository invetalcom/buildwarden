import type { ChatDetail, ChatRecord, ProjectSnapshot, RunDetail } from "@buildwarden/shared";
import type { BookmarkItem } from "./BookmarksPage";
import {
  firstOpenRunId,
  paneForOpenRunId,
  removeRunIdsFromOpenPanes,
  type OpenRunPanes,
  type RunPaneId,
} from "./app-model";
import type { ProjectPageTab } from "./project-page-tabs";

export interface SettingsPreviousPageState {
  landingSelected: boolean;
  allRunsSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  projectPageTab: ProjectPageTab;
  selectedBookmark: BookmarkItem | null;
  selectedChat: ChatRecord | null;
  chatDetail: ChatDetail | null;
  selectedRunId: string | null | undefined;
  runDetail: RunDetail | null;
  openRunPanes: OpenRunPanes;
  focusedRunPane: RunPaneId;
  runDetailsById: Record<string, RunDetail>;
}

export const reconcileSettingsPreviousPageAfterModelDeletion = (
  state: SettingsPreviousPageState,
  runIds: readonly string[],
  chatIds: readonly string[],
): SettingsPreviousPageState => {
  const deletedRunIds = new Set(runIds);
  const deletedChatIds = new Set(chatIds);
  const openRunPanes = removeRunIdsFromOpenPanes(state.openRunPanes, deletedRunIds);
  const runDetailsById = Object.fromEntries(
    Object.entries(state.runDetailsById).filter(([runId]) => !deletedRunIds.has(runId)),
  );
  const selectedRunWasDeleted = typeof state.selectedRunId === "string" && deletedRunIds.has(state.selectedRunId);
  const selectedRunId = selectedRunWasDeleted ? firstOpenRunId(openRunPanes) : state.selectedRunId;
  const focusedPaneStillOpen = openRunPanes[state.focusedRunPane] !== undefined;
  let focusedRunPane = state.focusedRunPane;
  if (selectedRunWasDeleted || !focusedPaneStillOpen) {
    focusedRunPane = selectedRunId ? paneForOpenRunId(openRunPanes, selectedRunId) ?? "left" : "left";
  }
  let runDetail = state.runDetail;
  if (selectedRunWasDeleted) runDetail = selectedRunId ? runDetailsById[selectedRunId] ?? null : null;
  else if (state.runDetail?.run.id && deletedRunIds.has(state.runDetail.run.id)) runDetail = null;

  return {
    ...state,
    selectedChat: state.selectedChat && deletedChatIds.has(state.selectedChat.id) ? null : state.selectedChat,
    chatDetail: state.chatDetail && deletedChatIds.has(state.chatDetail.chat.id) ? null : state.chatDetail,
    selectedRunId,
    runDetail,
    openRunPanes,
    focusedRunPane,
    runDetailsById,
  };
};

export interface MainViewFlagInput {
  settingsOpen: boolean;
  landingSelected: boolean;
  allRunsSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  selectedRunId: string | null | undefined;
  hasSelectedProject: boolean;
  hasRunDetail: boolean;
  openRunPaneCount: number;
  hasChatDetail: boolean;
  hasBookmarkDetail: boolean;
}

export const computeMainViewFlags = (input: MainViewFlagInput) => {
  const isSettingsView = input.settingsOpen;
  const onLandingOrEmptySelection =
    input.landingSelected || input.allRunsSelected || (!input.selectedRunId && !input.hasSelectedProject);
  const noOverlaySelected = !input.settingsOpen && !input.allRunsSelected && !input.bookmarksSelected;
  const isAgentRunDetailView =
    noOverlaySelected &&
    !input.chatsSelected &&
    !onLandingOrEmptySelection &&
    Boolean(input.selectedRunId && (input.hasRunDetail || input.openRunPaneCount > 0));
  const isChatDetailView = noOverlaySelected && input.chatsSelected && input.hasChatDetail;
  const isBookmarkDetailView = !input.settingsOpen && input.bookmarksSelected && input.hasBookmarkDetail;
  const isProjectWorkspaceView =
    noOverlaySelected && !input.chatsSelected && !input.landingSelected && !input.selectedRunId && input.hasSelectedProject;

  let sectionLayoutClassName = "space-y-4";
  if (isSettingsView || isAgentRunDetailView || isChatDetailView || isBookmarkDetailView) {
    sectionLayoutClassName = "flex min-h-0 min-w-0 flex-1 flex-col gap-2";
  } else if (isProjectWorkspaceView) {
    sectionLayoutClassName = "flex min-h-0 min-w-0 flex-1 flex-col gap-4";
  }

  return {
    onLandingOrEmptySelection,
    isSettingsView,
    isAgentRunDetailView,
    isChatDetailView,
    isBookmarkDetailView,
    isProjectWorkspaceView,
    sectionLayoutClassName,
  };
};

export const normalizeProjectFeatureTab = (
  projectKind: ProjectSnapshot["project"]["kind"] | undefined,
  requestedTab: ProjectPageTab,
): ProjectPageTab => {
  if (projectKind !== "folder") {
    return requestedTab;
  }
  return requestedTab === "branches" || requestedTab === "reviews" || requestedTab === "loops" ? "overview" : requestedTab;
};
