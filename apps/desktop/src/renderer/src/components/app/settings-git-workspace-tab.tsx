import type { ReactNode } from "react";
import type { AppSnapshot } from "@buildwarden/shared";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export type GitWorkspaceSettingsTabProps = {
  busy: boolean;
  projects: AppSnapshot["projects"];
  projectName: string;
  projectPath: string;
  projectFolderGitWarning: string | null;
  autoCheckoutRunBranchOnOpen: boolean;
  autoReleaseRunBranchOnLeave: boolean;
  recentRunDaysDraft: string;
  recentRunDaysInvalid: boolean;
  recentRunDaysMin: number;
  recentRunDaysMax: number;
  recentRunDaysDefault: number;
  worktreeRootDraft: string;
  worktreeRootOverrideSettingValue: string;
  worktreeRootDirty: boolean;
  worktreeRootSaving: boolean;
  builtInShellAllowlistPatterns: readonly string[];
  userShellPatternsDraft: string[];
  shellAllowlistDirty: boolean;
  shellAllowlistSaving: boolean;
  onChooseDirectory: () => void;
  onBrowseWorktreeRootDirectory: () => void | Promise<void>;
  onSubmitProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onAutoCheckoutRunBranchOnOpenChange: (value: boolean) => void;
  onAutoReleaseRunBranchOnLeaveChange: (value: boolean) => void;
  onRecentRunDaysDraftChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onWorktreeRootDraftChange: (value: string) => void;
  onSaveWorktreeRootOverride: () => void | Promise<void>;
  onResetWorktreeRootDraft: () => void;
  onUseDefaultWorktreeRoot: () => void;
  onUserShellPatternsDraftChange: (next: string[]) => void;
  onShellAllowlistExtraSave: () => void | Promise<void>;
  onResetShellAllowlistDraft: () => void;
};

type SettingsSectionProps = {
  title: string;
  children: ReactNode;
};

type SettingsRowProps = {
  title: string;
  description: ReactNode;
  children: ReactNode;
  align?: "center" | "start";
};

const SettingsSection = ({ title, children }: SettingsSectionProps) => (
  <section className="space-y-2">
    <h3 className="px-1 text-sm font-semibold text-[var(--ec-text)]">{title}</h3>
    <Card className="overflow-hidden p-0 shadow-none">{children}</Card>
  </section>
);

const SettingsRow = ({ title, description, children, align = "center" }: SettingsRowProps) => (
  <div
    className={`grid gap-3 border-b border-[var(--ec-border)] px-4 py-3 last:border-b-0 md:grid-cols-[minmax(14rem,0.85fr)_minmax(18rem,1.35fr)] ${
      align === "start" ? "md:items-start" : "md:items-center"
    }`}
  >
    <div className="min-w-0">
      <p className="text-sm font-medium text-[var(--ec-text)]">{title}</p>
      <div className="mt-1 text-xs leading-5 text-[var(--ec-muted)]">{description}</div>
    </div>
    <div className="min-w-0 w-full md:justify-self-end md:self-stretch">{children}</div>
  </div>
);

const rowControlClass = "w-full md:max-w-[42rem]";

export const GitWorkspaceSettingsTab = ({
  busy,
  projects,
  projectName,
  projectPath,
  projectFolderGitWarning,
  autoCheckoutRunBranchOnOpen,
  autoReleaseRunBranchOnLeave,
  recentRunDaysDraft,
  recentRunDaysInvalid,
  recentRunDaysMin,
  recentRunDaysMax,
  recentRunDaysDefault,
  worktreeRootDraft,
  worktreeRootOverrideSettingValue,
  worktreeRootDirty,
  worktreeRootSaving,
  builtInShellAllowlistPatterns,
  userShellPatternsDraft,
  shellAllowlistDirty,
  shellAllowlistSaving,
  onChooseDirectory,
  onBrowseWorktreeRootDirectory,
  onSubmitProject,
  onDeleteProject,
  onAutoCheckoutRunBranchOnOpenChange,
  onAutoReleaseRunBranchOnLeaveChange,
  onRecentRunDaysDraftChange,
  onProjectNameChange,
  onProjectPathChange,
  onWorktreeRootDraftChange,
  onSaveWorktreeRootOverride,
  onResetWorktreeRootDraft,
  onUseDefaultWorktreeRoot,
  onUserShellPatternsDraftChange,
  onShellAllowlistExtraSave,
  onResetShellAllowlistDraft,
}: GitWorkspaceSettingsTabProps) => {
  const normalizedWorktreeRootDraft = worktreeRootDraft.trim();

  return (
    <div className="space-y-5">
      <SettingsSection title="App behavior">
        <SettingsRow
          title="Auto checkout run branch"
          description="Git-only. When you open a Git worktree run, BuildWarden tries to reattach its branch."
        >
          <div className={`${rowControlClass} flex justify-start md:justify-end`}>
            <Switch
              checked={autoCheckoutRunBranchOnOpen}
              onCheckedChange={onAutoCheckoutRunBranchOnOpenChange}
              aria-label="Auto checkout run branch on open"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Auto release idle run branch"
          description="Git-only. When you leave a completed Git worktree run, BuildWarden detaches the worktree so another IDE can check out the branch."
        >
          <div className={`${rowControlClass} flex justify-start md:justify-end`}>
            <Switch
              checked={autoReleaseRunBranchOnLeave}
              onCheckedChange={onAutoReleaseRunBranchOnLeaveChange}
              aria-label="Auto release idle run branch on leave"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Recent runs window"
          description={`Controls how many days appear in the sidebar Recent Runs group. Default is ${recentRunDaysDefault} days.`}
          align="start"
        >
          <div className={`${rowControlClass} space-y-2`}>
            <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
              <label className="flex h-9 w-36 items-center overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)]">
                <input
                  className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-[var(--ec-text)] outline-none"
                  type="number"
                  min={recentRunDaysMin}
                  max={recentRunDaysMax}
                  step={1}
                  value={recentRunDaysDraft}
                  onChange={(event) => onRecentRunDaysDraftChange(event.target.value)}
                  aria-label="Recent runs days"
                />
                <span className="inline-flex h-full items-center border-l border-[var(--ec-border)] px-2 text-[11px] text-[var(--ec-muted)]">
                  days
                </span>
              </label>
            </div>
            {recentRunDaysInvalid ? (
              <p className="text-xs text-[var(--ec-danger)] md:text-right">
                Enter a whole number between {recentRunDaysMin} and {recentRunDaysMax}.
              </p>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Projects">
        <SettingsRow
          title="Add project folder"
          description="Register a local folder. Git repositories enable branches, worktrees, commits, and PR/MR review; plain folders can still run agents."
          align="start"
        >
          <div className={`${rowControlClass} space-y-2`}>
            <div className="flex min-w-0 flex-wrap gap-2 sm:flex-nowrap">
              <Input
                className="min-w-[12rem] flex-1"
                placeholder="Path to project folder"
                value={projectPath}
                onChange={(event) => onProjectPathChange(event.target.value)}
              />
              <Button type="button" variant="secondary" className="shrink-0" onClick={onChooseDirectory}>
                Browse
              </Button>
              <Button type="button" className="shrink-0" onClick={onSubmitProject} disabled={busy || !projectPath}>
                Add project
              </Button>
            </div>
            <Input placeholder="Display name (optional)" value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} />
            {projectFolderGitWarning ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
                <span className="min-w-0">{projectFolderGitWarning}</span>
              </div>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow title="Existing projects" description="Remove projects from BuildWarden without deleting the original folder." align="start">
          <div className={`${rowControlClass} app-scrollbar max-h-72 overflow-auto rounded-md border border-[var(--ec-border)]`}>
            {projects.length > 0 ? (
              projects.map((entry) => (
                <div
                  key={entry.project.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--ec-text)]">{entry.project.name}</p>
                    <p className="truncate text-xs text-[var(--ec-muted)]">{entry.project.repoPath}</p>
                  </div>
                  <Button type="button" variant="danger" size="sm" className="shrink-0" onClick={() => onDeleteProject(entry.project.id)}>
                    Delete
                  </Button>
                </div>
              ))
            ) : (
              <p className="px-3 py-2.5 text-sm text-[var(--ec-muted)]">No projects added yet.</p>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Managed workspaces">
        <SettingsRow
          title="Custom workspace folder"
          description="Optional absolute directory for new Git worktrees and folder copies. Leave it blank to keep the default sibling-folder behavior."
          align="start"
        >
          <div className={`${rowControlClass} space-y-2`}>
            <div className="flex min-w-0 flex-wrap gap-2 sm:flex-nowrap">
              <Input
                className="min-w-[12rem] flex-1 font-mono text-xs"
                value={worktreeRootDraft}
                onChange={(event) => onWorktreeRootDraftChange(event.target.value)}
                placeholder="Default: parent/.buildwarden-worktrees/<project-name>"
                spellCheck={false}
              />
              <Button type="button" variant="secondary" className="shrink-0" onClick={() => void onBrowseWorktreeRootDirectory()}>
                Browse
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
              <Button type="button" size="sm" disabled={!worktreeRootDirty || worktreeRootSaving} onClick={() => void onSaveWorktreeRootOverride()}>
                {worktreeRootSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!worktreeRootDirty || worktreeRootSaving}
                onClick={onResetWorktreeRootDraft}
              >
                Reset
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={worktreeRootSaving || !normalizedWorktreeRootDraft}
                onClick={onUseDefaultWorktreeRoot}
              >
                Use default
              </Button>
            </div>
            <div className="text-xs leading-5 text-[var(--ec-muted)] md:text-right">
              <p>Existing runs keep using their stored workspace paths, so changing this only affects newly created worktrees and folder copies.</p>
              {worktreeRootOverrideSettingValue.trim() ? <p>Saved override: {worktreeRootOverrideSettingValue.trim()}</p> : null}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Shell commands">
        <SettingsRow
          title="Shell allowlist"
          description={
            <>
              Agent runs can execute <code className="rounded bg-[var(--ec-control)] px-1 py-0.5 text-[11px]">run_shell</code> only when the
              command matches one of these case-insensitive regex patterns. Built-ins ship with the app; custom rows are stored locally.
            </>
          }
          align="start"
        >
          <div className={`${rowControlClass} space-y-3`}>
            <div className="app-scrollbar max-h-[min(24rem,50vh)] overflow-auto rounded-md border border-[var(--ec-border)]">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-[var(--ec-panel)]">
                  <tr className="border-b border-[var(--ec-border)]">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ec-muted)]">Pattern</th>
                    <th className="w-32 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ec-muted)]">Source</th>
                    <th className="w-20 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ec-muted)]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {builtInShellAllowlistPatterns.map((pattern, index) => (
                    <tr key={`builtin-${index}-${pattern}`} className="border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)]">
                      <td className="px-3 py-2 align-top">
                        <code className="block whitespace-pre-wrap break-all font-mono text-xs text-[var(--ec-text)]">{pattern}</code>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <span className="inline-flex rounded-full bg-[var(--ec-control)] px-2.5 py-1 text-xs font-medium text-[var(--ec-muted)] ring-1 ring-[var(--ec-border)]">
                          Built-in
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle text-xs text-[var(--ec-faint)]">-</td>
                    </tr>
                  ))}
                  {userShellPatternsDraft.map((pattern, index) => (
                    <tr key={`user-${index}`} className="border-b border-[var(--ec-border)]">
                      <td className="px-3 py-2 align-top">
                        <Input
                          className="h-8 font-mono text-xs"
                          value={pattern}
                          onChange={(event) => {
                            const next = event.target.value;
                            onUserShellPatternsDraftChange(userShellPatternsDraft.map((value, valueIndex) => (valueIndex === index ? next : value)));
                          }}
                          placeholder="^your-command regex$"
                          spellCheck={false}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <span className="inline-flex rounded-full bg-[var(--ec-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--ec-accent)] ring-1 ring-[var(--ec-accent-ring)]">
                          Custom
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-[var(--ec-muted)] hover:text-[var(--ec-danger)]"
                          aria-label="Remove pattern"
                          disabled={shellAllowlistSaving}
                          onClick={() => onUserShellPatternsDraftChange(userShellPatternsDraft.filter((_, valueIndex) => valueIndex !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={shellAllowlistSaving}
                onClick={() => onUserShellPatternsDraftChange([...userShellPatternsDraft, ""])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add pattern
              </Button>
              <Button type="button" size="sm" disabled={!shellAllowlistDirty || shellAllowlistSaving} onClick={() => void onShellAllowlistExtraSave()}>
                {shellAllowlistSaving ? "Saving..." : "Save custom patterns"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!shellAllowlistDirty || shellAllowlistSaving}
                onClick={onResetShellAllowlistDraft}
              >
                Discard changes
              </Button>
            </div>
            <p className="text-xs leading-5 text-[var(--ec-muted)] md:text-right">
              Save applies your custom rows only; built-ins cannot be removed. Invalid regex lines are ignored when matching commands.
            </p>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};
