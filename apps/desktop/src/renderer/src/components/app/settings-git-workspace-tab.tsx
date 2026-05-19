import type { AppSnapshot } from "@easycode/shared";
import { FolderGit2, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

export type GitWorkspaceSettingsTabProps = {
  busy: boolean;
  projects: AppSnapshot["projects"];
  projectName: string;
  projectPath: string;
  autoCheckoutRunBranchOnOpen: boolean;
  autoReleaseRunBranchOnLeave: boolean;
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

export const GitWorkspaceSettingsTab = ({
  busy,
  projects,
  projectName,
  projectPath,
  autoCheckoutRunBranchOnOpen,
  autoReleaseRunBranchOnLeave,
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
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="overflow-auto p-5">
        <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">App behavior</p>
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <input
              className="mt-1 h-4 w-4 accent-cyan-400"
              type="checkbox"
              checked={autoCheckoutRunBranchOnOpen}
              onChange={(event) => onAutoCheckoutRunBranchOnOpenChange(event.target.checked)}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">Auto checkout run branch on open</p>
              <p className="mt-1 text-xs text-zinc-500">
                Recommended. When you open a run, Easycode tries to reattach its branch in the worktree.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <input
              className="mt-1 h-4 w-4 accent-cyan-400"
              type="checkbox"
              checked={autoReleaseRunBranchOnLeave}
              onChange={(event) => onAutoReleaseRunBranchOnLeaveChange(event.target.checked)}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">Auto release idle run branch on leave</p>
              <p className="mt-1 text-xs text-zinc-500">
                Recommended. When you leave a completed run, Easycode detaches the worktree so another IDE can check out the branch.
              </p>
            </div>
          </label>
        </div>
      </Card>

      <Card className="overflow-auto p-5">
        <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Project onboarding</p>
        <div className="mt-4 space-y-3">
          <Input placeholder="Display name (optional)" value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} />
          <div className="flex gap-2">
            <Input placeholder="Path to Git repository" value={projectPath} onChange={(event) => onProjectPathChange(event.target.value)} />
            <Button variant="secondary" onClick={onChooseDirectory}>
              Browse
            </Button>
          </div>
          <Button className="w-full" onClick={onSubmitProject} disabled={busy || !projectPath}>
            Add project
          </Button>
        </div>
        <div className="mt-6 space-y-2">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Existing projects</p>
          {projects.length > 0 ? (
            projects.map((entry) => (
              <div
                key={entry.project.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{entry.project.name}</p>
                  <p className="truncate text-xs text-zinc-500">{entry.project.repoPath}</p>
                </div>
                <Button variant="danger" size="sm" onClick={() => onDeleteProject(entry.project.id)}>
                  Delete
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-zinc-500">No projects added yet.</p>
          )}
        </div>
      </Card>

      <Card className="overflow-auto p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-cyan-300">
            <FolderGit2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Worktrees</p>
            <p className="mt-2 text-sm font-medium text-zinc-100">Custom worktree folder</p>
            <p className="mt-1 text-sm text-zinc-400">
              Optional absolute directory for new agent-run worktrees. Leave it blank to keep the default sibling-folder behavior.
            </p>
            <div className="mt-4 flex gap-2">
              <Input
                className="font-mono text-xs"
                value={worktreeRootDraft}
                onChange={(event) => onWorktreeRootDraftChange(event.target.value)}
                placeholder="Default: parent of repo/.easycode-worktrees/<repo-name>"
                spellCheck={false}
              />
              <Button type="button" variant="secondary" onClick={() => void onBrowseWorktreeRootDirectory()}>
                Browse
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={!worktreeRootDirty || worktreeRootSaving} onClick={() => void onSaveWorktreeRootOverride()}>
                {worktreeRootSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save worktree folder"
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
            <p className="mt-2 text-xs text-zinc-500">
              Existing runs keep using their stored worktree paths, so changing this only affects newly created worktrees.
            </p>
            {worktreeRootOverrideSettingValue.trim() ? (
              <p className="mt-1 text-xs text-zinc-600">Saved override: {worktreeRootOverrideSettingValue.trim()}</p>
            ) : null}
          </div>
        </div>
      </Card>

      <Card className="overflow-auto p-5 md:col-span-2">
        <div className="flex items-start gap-3">
          <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-cyan-300">
            <Terminal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Shell command allowlist</p>
            <p className="mt-2 text-sm text-zinc-400">
              Agent runs can execute <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">run_shell</code> only when the command
              matches one of these patterns (case-insensitive regex). Built-ins ship with the app; custom rows are stored in your local
              database. &quot;Always allow (save to settings)&quot; on the approval dialog adds a custom exact-match pattern&apos;you can
              edit or remove it here after saving.
            </p>
            <div className="app-scrollbar mt-4 max-h-[min(28rem,55vh)] overflow-auto rounded-lg border border-zinc-800">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-zinc-950/95 backdrop-blur-sm">
                  <tr className="border-b border-zinc-800">
                    <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pattern</th>
                    <th className="w-36 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Source</th>
                    <th className="w-24 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {builtInShellAllowlistPatterns.map((pattern, index) => (
                    <tr key={`builtin-${index}-${pattern}`} className="border-b border-zinc-800/80 bg-zinc-950/40">
                      <td className="px-3 py-2 align-top">
                        <code className="block whitespace-pre-wrap break-all font-mono text-xs text-zinc-300">{pattern}</code>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <span className="inline-flex rounded-full bg-zinc-500/15 px-2.5 py-1 text-xs font-medium text-zinc-400 ring-1 ring-zinc-600/50">
                          Built-in
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle text-xs text-zinc-600">—</td>
                    </tr>
                  ))}
                  {userShellPatternsDraft.map((pattern, index) => (
                    <tr key={`user-${index}`} className="border-b border-zinc-800/80">
                      <td className="px-3 py-2 align-top">
                        <Input
                          className="font-mono text-xs"
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
                        <span className="inline-flex rounded-full bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-300 ring-1 ring-cyan-500/30">
                          Custom
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-zinc-500 hover:text-rose-400"
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={shellAllowlistSaving}
                onClick={() => onUserShellPatternsDraftChange([...userShellPatternsDraft, ""])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add custom pattern
              </Button>
              <Button type="button" disabled={!shellAllowlistDirty || shellAllowlistSaving} onClick={() => void onShellAllowlistExtraSave()}>
                {shellAllowlistSaving ? "Saving…" : "Save custom patterns"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!shellAllowlistDirty || shellAllowlistSaving}
                onClick={onResetShellAllowlistDraft}
              >
                Discard changes
              </Button>
            </div>
            <p className="mt-2 text-xs text-zinc-600">
              Save applies your custom rows only; built-ins cannot be removed. Invalid regex lines are ignored when matching commands.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};
