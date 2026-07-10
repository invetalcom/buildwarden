import type { AppSnapshot, KeyboardShortcutId, RunRecord } from "@buildwarden/shared";
import { eventToKeyString } from "./app-model";

export interface AppShortcutHandlerDeps {
  shortcuts: Record<KeyboardShortcutId, string>;
  snapshotProjects: AppSnapshot["projects"];
  welcomeOpen: boolean;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  selectedRunId: string | null | undefined;
  runDetailRun: RunRecord | null;
  runProjectId: string;
  openCommandPalette: () => void;
  closeSettings: () => void;
  openSettings: () => void;
  goHome: () => void;
  toggleSidebar: () => void;
  selectRun: (projectId: string, runId: string) => void;
  openProject: (projectId: string) => void;
  deleteRun: (run: RunRecord) => void;
  cancelRun: (run: RunRecord) => void;
}

const recentRunsNewestFirst = (projects: AppSnapshot["projects"]) =>
  projects
    .flatMap((entry) => entry.runs.map((run) => ({ projectId: entry.project.id, run })))
    .sort((a, b) => new Date(b.run.updatedAt).getTime() - new Date(a.run.updatedAt).getTime());

const handleGlobalShortcut = (keyStr: string, deps: AppShortcutHandlerDeps): boolean => {
  const { shortcuts } = deps;
  if (keyStr === shortcuts.openSettings) {
    deps.openSettings();
    return true;
  }
  if (keyStr === shortcuts.goHome) {
    deps.goHome();
    return true;
  }
  if (keyStr === shortcuts.toggleSidebar) {
    deps.toggleSidebar();
    return true;
  }
  return false;
};

/** Returns true when the shortcut matched a "switch to recent run" slot (even if no run exists for it). */
const handleRecentRunShortcut = (keyStr: string, deps: AppShortcutHandlerDeps, preventDefault: () => void): boolean => {
  const { shortcuts } = deps;
  const recentRunShortcuts = [
    shortcuts.switchToRecentRun1,
    shortcuts.switchToRecentRun2,
    shortcuts.switchToRecentRun3,
    shortcuts.switchToRecentRun4,
    shortcuts.switchToRecentRun5,
  ];
  const recentRunIndex = recentRunShortcuts.indexOf(keyStr);
  if (recentRunIndex === -1) {
    return false;
  }
  if (deps.bookmarksSelected || deps.chatsSelected) {
    return true;
  }
  const picked = recentRunsNewestFirst(deps.snapshotProjects)[recentRunIndex];
  if (picked) {
    preventDefault();
    deps.selectRun(picked.projectId, picked.run.id);
  }
  return true;
};

const handleRunDetailShortcut = (keyStr: string, deps: AppShortcutHandlerDeps): boolean => {
  const run = deps.runDetailRun;
  if (!deps.selectedRunId || !run) {
    return false;
  }
  const { shortcuts } = deps;

  if (keyStr === shortcuts.newAgentRun || keyStr === shortcuts.backToProject) {
    deps.openProject(deps.runProjectId);
    return true;
  }
  if (keyStr === shortcuts.deleteRun) {
    deps.deleteRun(run);
    return true;
  }
  const isRunActive = ["queued", "preparing", "running"].includes(run.status);
  if (keyStr === shortcuts.cancelRun && isRunActive) {
    deps.cancelRun(run);
    return true;
  }
  return false;
};

/**
 * Global keydown handler for app-level shortcuts. Ordering matters: the
 * command palette shortcut always wins, open overlays swallow everything
 * else, and run-scoped shortcuts only apply while a run is selected.
 */
export const createAppKeyboardShortcutHandler = (deps: AppShortcutHandlerDeps) => (e: KeyboardEvent): void => {
  if (deps.welcomeOpen) {
    return;
  }

  const keyStr = eventToKeyString(e);

  if (keyStr === deps.shortcuts.openCommandPalette) {
    e.preventDefault();
    deps.openCommandPalette();
    return;
  }

  if (deps.commandPaletteOpen) {
    return;
  }

  if (deps.settingsOpen) {
    if (keyStr === deps.shortcuts.closeSettings) {
      e.preventDefault();
      deps.closeSettings();
    }
    return;
  }

  if (handleGlobalShortcut(keyStr, deps)) {
    e.preventDefault();
    return;
  }

  if (handleRecentRunShortcut(keyStr, deps, () => e.preventDefault())) {
    return;
  }

  if (handleRunDetailShortcut(keyStr, deps)) {
    e.preventDefault();
  }
};
