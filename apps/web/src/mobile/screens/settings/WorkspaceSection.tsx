import { useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  DEFAULT_RECENT_RUN_DAYS,
  DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES,
  MAX_RECENT_RUN_DAYS,
  MIN_RECENT_RUN_DAYS,
  parseRecentRunDaysSetting,
  parseShellAllowlistExtraSetting,
} from "@buildwarden/shared";
import { FolderGit2, FolderPlus, Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { useAppSettings } from "../../data/use-app-settings";
import { SettingGroup, StringListEditor, TextRow, ToggleRow } from "../../components/SettingControls";
import { ConfirmSheet } from "../../components/Sheet";
import { Button, InlineError, ListRow } from "../../components/primitives";
import { HostDirectoryPicker } from "./HostDirectoryPicker";

/** "Projects & workspace" — the mobile counterpart of the desktop Git/Workspace settings tab. */
export const WorkspaceSection = () => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const settings = useAppSettings();
  const action = useAction();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const disabled = !settings.canWrite || settings.saving;
  const recentRunDays = parseRecentRunDaysSetting(settings.read(APP_SETTING_KEYS.recentRunDays));
  const worktreeRoot = settings.read(APP_SETTING_KEYS.worktreeRootOverride) ?? "";
  // Memoise on the raw persisted string: `settings` itself is a fresh object every render.
  const shellAllowlistRaw = settings.read(APP_SETTING_KEYS.shellAllowlistExtra);
  const extraShellPatterns = useMemo(() => parseShellAllowlistExtraSetting(shellAllowlistRaw), [shellAllowlistRaw]);

  return (
    <>
      {settings.error ? <InlineError message={settings.error} onRetry={settings.clearError} /> : null}
      {action.error ? <InlineError message={action.error} /> : null}

      <SettingGroup title="Run branches">
        <ToggleRow
          title="Check out the run branch when opening a run"
          description="Switches your local checkout to the run's branch."
          checked={settings.read(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen) === "true"}
          disabled={disabled}
          onChange={(next) => void settings.write(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, String(next))}
        />
        <ToggleRow
          title="Release the branch when leaving a run"
          description="Restores the previous branch after you navigate away."
          checked={settings.read(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave) === "true"}
          disabled={disabled}
          onChange={(next) => void settings.write(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, String(next))}
        />
      </SettingGroup>

      <SettingGroup title="Workspace">
        <TextRow
          title="Recent runs window"
          description={`Days of history shown as "recent" (${MIN_RECENT_RUN_DAYS}–${MAX_RECENT_RUN_DAYS}, default ${DEFAULT_RECENT_RUN_DAYS}).`}
          value={String(recentRunDays)}
          inputMode="numeric"
          disabled={disabled}
          invalid={(draft) => {
            const parsed = Number(draft);
            if (!draft.trim() || !Number.isFinite(parsed)) return "Enter a number.";
            if (parsed < MIN_RECENT_RUN_DAYS || parsed > MAX_RECENT_RUN_DAYS) {
              return `Must be between ${MIN_RECENT_RUN_DAYS} and ${MAX_RECENT_RUN_DAYS}.`;
            }
            return null;
          }}
          onCommit={(next) => void settings.write(APP_SETTING_KEYS.recentRunDays, String(parseRecentRunDaysSetting(next)))}
        />
        <TextRow
          title="Worktree root override"
          description="Absolute host directory for app-created worktrees. Leave blank for the default sibling folder."
          value={worktreeRoot}
          placeholder="/Users/you/worktrees"
          mono
          disabled={disabled}
          onCommit={(next) => void settings.write(APP_SETTING_KEYS.worktreeRootOverride, next.trim())}
        />
      </SettingGroup>

      <SettingGroup
        title="Extra shell allow-list"
        hint={`Regular expressions added to the ${DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES.length} built-in patterns. Matching commands run without an approval prompt.`}
      >
        <StringListEditor
          values={extraShellPatterns}
          placeholder="^git status"
          disabled={disabled}
          onChange={(next) => void settings.write(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(next))}
        />
      </SettingGroup>

      <SettingGroup title="Projects">
        {snapshot.projects.map((entry) => (
          <ListRow
            key={entry.project.id}
            leading={<FolderGit2 className="size-5" />}
            title={entry.project.name}
            subtitle={entry.project.repoPath}
            className="border-b border-[var(--ec-border)] last:border-b-0"
            trailing={
              client.capabilities.projectCreation ? (
                <button
                  type="button"
                  aria-label={`Delete ${entry.project.name}`}
                  onClick={() => setPendingDelete({ id: entry.project.id, name: entry.project.name })}
                  className="m-tap flex size-11 items-center justify-center text-[var(--ec-danger)]"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : undefined
            }
          />
        ))}
        <div className="px-4 py-3">
          {client.capabilities.hostDirectoryBrowser ? (
            <Button tone="neutral" block onClick={() => setPickerOpen(true)}>
              <FolderPlus className="size-4" />
              Add a project from the host
            </Button>
          ) : (
            <p className="text-[11px] leading-4 text-[var(--ec-muted)]">
              This session cannot browse host folders. Add projects from the desktop app.
            </p>
          )}
        </div>
      </SettingGroup>

      <div className="h-6" />

      <HostDirectoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdded={async (projectId) => {
          setPickerOpen(false);
          await snapshotStore.refresh();
          router.push({ name: "project", projectId, tab: "overview" });
        }}
      />

      <ConfirmSheet
        open={pendingDelete !== null}
        title="Delete project"
        message={`Remove “${pendingDelete?.name ?? ""}” and its BuildWarden worktrees? The repository itself stays on disk.`}
        confirmLabel="Delete"
        danger
        busy={action.busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          void action.ok(() => client.deleteProject(target.id), "Could not delete the project.").then(async (deleted) => {
            if (!deleted) return;
            setPendingDelete(null);
            await snapshotStore.refresh();
          });
        }}
      />
    </>
  );
};
