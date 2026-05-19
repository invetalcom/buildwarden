import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDE_KIND_LABELS,
  KEYBOARD_SHORTCUT_IDS,
  SUPPORTED_IDE_KINDS,
  type KeyboardShortcutId,
  type SupportedIdeKind,
  type UiTheme,
} from "@easycode/shared";
import { Database, Keyboard, Loader2, Settings2, Terminal } from "lucide-react";
import { IdeBrandIcon } from "./ide-brand-icons";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

const SHORTCUT_LABELS: Record<KeyboardShortcutId, string> = {
  goHome: "Go to starting page",
  toggleSidebar: "Toggle sidebar",
  submitComposer: "Submit run/chat from composer",
  newAgentRun: "New agent run (same project; only while viewing a run)",
  switchToRecentRun1: "Recent run #1 (newest by activity across all projects)",
  switchToRecentRun2: "Recent run #2 across all projects",
  switchToRecentRun3: "Recent run #3 across all projects",
  switchToRecentRun4: "Recent run #4 across all projects",
  switchToRecentRun5: "Recent run #5 across all projects",
  deleteRun: "Delete run",
  cancelRun: "Cancel active run",
  backToProject: "Back to project",
  openSettings: "Open settings",
  closeSettings: "Close settings",
};

const APPEARANCE_OPTIONS: Array<{ value: UiTheme; label: string; hint: string }> = [
  { value: "dark", label: "Deep dark", hint: "Near-black canvas and glass panels." },
  { value: "dim", label: "Balanced gray", hint: "Mid gray; softer than deep dark." },
  { value: "light", label: "Bright", hint: "Light grey shell with inverted panels." },
];

const eventToKeyString = (event: KeyboardEvent): string => {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const key = event.key.toLowerCase();
  if (key === " ") parts.push("space");
  else if (!["control", "meta", "alt", "shift"].includes(key)) parts.push(key);
  return parts.join("+");
};

const ShortcutRow = ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => {
  const [recording, setRecording] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const keyStr = eventToKeyString(event);
    if (keyStr === "escape") {
      setRecording(false);
      return;
    }
    onChangeRef.current(keyStr);
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) {
      return;
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [recording, handleKeyDown]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-zinc-200">{label}</p>
      </div>
      <button
        type="button"
        className="flex min-w-[128px] shrink-0 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/80 px-2.5 py-1.5 text-left text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800"
        onClick={() => setRecording(true)}
      >
        <Keyboard className="h-3 w-3 shrink-0 text-zinc-500" />
        <span className="truncate">{recording ? "Press keys…" : value || "—"}</span>
      </button>
    </div>
  );
};

export type UserSettingsTabProps = {
  busy: boolean;
  uiTheme: UiTheme;
  enableDevMode: boolean;
  appLogDirPath: string;
  ideDraft: Partial<Record<SupportedIdeKind, string>>;
  idePathsDirty: boolean;
  idePathsSaving: boolean;
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
  onUiThemeChange: (theme: UiTheme) => void;
  onEnableDevModeChange: (value: boolean) => void;
  onKeyboardShortcutChange: (id: KeyboardShortcutId, value: string) => void;
  onOpenAppLogDirectory: () => void | Promise<void>;
  onResetDatabase: () => void | Promise<void>;
  onIdeDraftChange: (next: Partial<Record<SupportedIdeKind, string>>) => void;
  onSaveIdePaths: () => void | Promise<void>;
  onResetIdeDraft: () => void;
  onPickIdeExecutable: (kind: SupportedIdeKind) => void | Promise<void>;
};

export const UserSettingsTab = ({
  busy,
  uiTheme,
  enableDevMode,
  appLogDirPath,
  ideDraft,
  idePathsDirty,
  idePathsSaving,
  keyboardShortcuts,
  onUiThemeChange,
  onEnableDevModeChange,
  onKeyboardShortcutChange,
  onOpenAppLogDirectory,
  onResetDatabase,
  onIdeDraftChange,
  onSaveIdePaths,
  onResetIdeDraft,
  onPickIdeExecutable,
}: UserSettingsTabProps) => (
  <div className="space-y-4">
    <Card className="overflow-auto p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-cyan-300">
          <Settings2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Appearance</p>
          <p className="mt-2 text-sm font-medium text-zinc-100">Interface theme</p>
          <p className="mt-1 text-sm text-zinc-400">Choose deep dark, balanced gray, or the bright light-grey shell.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Interface appearance">
            {APPEARANCE_OPTIONS.map((opt) => {
              const selected = uiTheme === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`cursor-pointer rounded-xl border px-3 py-2.5 transition ${
                    selected
                      ? "border-cyan-500/45 bg-cyan-500/10 shadow-[inset_0_1px_0_rgba(34,211,238,0.12)]"
                      : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700"
                  }`}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="easycode-ui-theme"
                    checked={selected}
                    onChange={() => onUiThemeChange(opt.value)}
                  />
                  <p className="text-sm font-medium text-zinc-100">{opt.label}</p>
                  <p className="mt-1 text-xs leading-snug text-zinc-500">{opt.hint}</p>
                </label>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-zinc-500">Same options appear at the top of the View menu.</p>
        </div>
      </div>
    </Card>

    <Card className="overflow-hidden p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">External editors</p>
          <p className="mt-1 text-sm text-zinc-400">
            Point each IDE at its executable. On Windows use <code className="text-zinc-300">.exe</code>; on macOS you can choose the{" "}
            <code className="text-zinc-300">.app</code> bundle. Only configured editors appear when opening a run workspace from the run page.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={!idePathsDirty || idePathsSaving} onClick={onResetIdeDraft}>
            Reset
          </Button>
          <Button type="button" size="sm" disabled={!idePathsDirty || idePathsSaving} onClick={() => void onSaveIdePaths()}>
            {idePathsSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save IDE paths"
            )}
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SUPPORTED_IDE_KINDS.map((kind) => (
          <div
            key={kind}
            className="group relative overflow-hidden rounded-2xl border border-zinc-800/90 bg-gradient-to-b from-zinc-900/50 to-zinc-950/80 p-4 shadow-inner ring-1 ring-zinc-800/60 transition hover:border-cyan-500/25 hover:ring-cyan-500/10"
          >
            <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-cyan-500/5 blur-2xl transition group-hover:bg-cyan-400/10" />
            <div className="relative flex items-start gap-3">
              <div className="rounded-xl border border-zinc-700/80 bg-zinc-950/80 p-2 shadow-sm">
                <IdeBrandIcon kind={kind} className="h-9 w-9" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-zinc-100">{IDE_KIND_LABELS[kind]}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">Executable or app bundle</p>
              </div>
            </div>
            <Input
              className="relative mt-3 font-mono text-xs"
              value={ideDraft[kind] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                const next = { ...ideDraft };
                if (!value.trim()) {
                  delete next[kind];
                } else {
                  next[kind] = value;
                }
                onIdeDraftChange(next);
              }}
              placeholder={
                kind === "vscode" ? "Code.exe or Visual Studio Code.app" : kind === "cursor" ? "Cursor.exe or Cursor.app" : "idea64.exe or IntelliJ IDEA.app"
              }
              spellCheck={false}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="relative mt-2 w-full"
              disabled={idePathsSaving}
              onClick={() => void onPickIdeExecutable(kind)}
            >
              Browse…
            </Button>
          </div>
        ))}
      </div>
    </Card>

    <Card className="overflow-auto p-5">
      <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Keyboard shortcuts</p>
      <p className="mt-2 text-sm text-zinc-400">
        Customize key combinations for common actions. Click a field and press the desired keys. Shortcuts that apply only on certain screens are noted in the label.
      </p>
      <div className="mt-4 space-y-3">
        {KEYBOARD_SHORTCUT_IDS.map((id) => (
          <ShortcutRow key={id} label={SHORTCUT_LABELS[id]} value={keyboardShortcuts[id]} onChange={(value) => onKeyboardShortcutChange(id, value)} />
        ))}
      </div>
    </Card>

    <Card className="overflow-auto p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-amber-300">
          <Terminal className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Diagnostics</p>
          <p className="mt-2 text-sm font-medium text-zinc-100">Enable dev mode</p>
          <p className="mt-1 text-sm text-zinc-400">
            Disabled by default. When enabled, Easycode writes provider API requests and responses to local log files for debugging.
          </p>
          <label className="mt-4 flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <input
              className="mt-1 h-4 w-4 accent-cyan-400"
              type="checkbox"
              checked={enableDevMode}
              onChange={(event) => onEnableDevModeChange(event.target.checked)}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">Write request/response logs</p>
              <p className="mt-1 text-xs text-zinc-500">
                Logs are stored locally and can become verbose. Turn this on only when you need debugging details.
              </p>
            </div>
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!appLogDirPath} onClick={() => void onOpenAppLogDirectory()}>
              Open log folder
            </Button>
            {appLogDirPath ? (
              <code className="max-w-full truncate rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-400">{appLogDirPath}</code>
            ) : (
              <span className="text-xs text-zinc-600">Log folder unavailable</span>
            )}
          </div>
        </div>
      </div>
    </Card>

    <Card className="overflow-auto p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-rose-300">
          <Database className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Data</p>
          <p className="mt-2 text-sm font-medium text-zinc-100">Clear database</p>
          <p className="mt-1 text-sm text-zinc-400">
            Permanently delete all projects, runs, bookmarks, providers, models, and settings. The app will restart with a fresh database. This cannot be undone.
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-4"
            disabled={busy}
            onClick={() => {
              const confirmed = window.confirm(
                "Clear the entire database? All projects, runs, bookmarks, providers, models, and settings will be permanently deleted. The app will restart. This cannot be undone.",
              );
              if (confirmed) {
                void onResetDatabase();
              }
            }}
          >
            Clear database and restart
          </Button>
        </div>
      </div>
    </Card>
  </div>
);
