import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  IDE_KIND_LABELS,
  KEYBOARD_SHORTCUT_IDS,
  SUPPORTED_IDE_KINDS,
  type AppLogDirectorySizeInfo,
  type KeyboardShortcutId,
  type SupportedIdeKind,
  type UiTheme,
} from "@buildwarden/shared";
import { Keyboard, Loader2 } from "lucide-react";
import { IdeBrandIcon } from "./ide-brand-icons";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

const SHORTCUT_LABELS: Record<KeyboardShortcutId, string> = {
  goHome: "Go to starting page",
  toggleSidebar: "Toggle sidebar",
  openCommandPalette: "Open command palette",
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
  { value: "dark", label: "Dark", hint: "Frosted glass over a deep dark backdrop." },
  { value: "light", label: "Light", hint: "Frosted glass over a bright airy backdrop." },
];

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
    <div className={`min-w-0 w-full md:justify-self-end ${align === "start" ? "md:self-start" : "md:self-center"}`}>{children}</div>
  </div>
);

const rowControlClass = "w-full md:max-w-[54rem]";

const idePathPlaceholder = (kind: SupportedIdeKind): string => {
  if (kind === "vscode") {
    return "Code.exe or Visual Studio Code.app";
  }
  if (kind === "cursor") {
    return "Cursor.exe or Cursor.app";
  }
  return "idea64.exe or IntelliJ IDEA.app";
};

const formatByteSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  let maximumFractionDigits = 2;
  if (unitIndex === 0 || value >= 100) {
    maximumFractionDigits = 0;
  } else if (value >= 10) {
    maximumFractionDigits = 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`;
};

const formatLogDirectorySize = ({ totalBytes, fileCount, unreadableEntryCount }: AppLogDirectorySizeInfo): string => {
  const fileLabel = fileCount === 1 ? "file" : "files";
  const partialLabel = unreadableEntryCount > 0 ? " - partial" : "";
  return `${formatByteSize(totalBytes)} - ${fileCount.toLocaleString()} ${fileLabel}${partialLabel}`;
};

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
    <div className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--ec-text)]">{label}</p>
      </div>
      <button
        type="button"
        className="flex min-w-[128px] shrink-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-control)] px-2.5 py-1.5 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
        onClick={() => setRecording(true)}
      >
        <Keyboard className="h-3 w-3 shrink-0 text-[var(--ec-muted)]" />
        <span className="truncate">{recording ? "Press keys..." : value || "-"}</span>
      </button>
    </div>
  );
};

const EditorPathCard = ({
  kind,
  value,
  saving,
  onValueChange,
  onPickExecutable,
  canBrowseHostPaths,
}: {
  kind: SupportedIdeKind;
  value: string;
  saving: boolean;
  onValueChange: (value: string) => void;
  onPickExecutable: () => void | Promise<void>;
  canBrowseHostPaths: boolean;
}) => {
  const configured = value.trim().length > 0;

  return (
    <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3 transition hover:bg-[var(--ec-hover)]">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-sm">
          <IdeBrandIcon kind={kind} className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{IDE_KIND_LABELS[kind]}</p>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                configured
                  ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
                  : "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-muted)]"
              }`}
            >
              {configured ? "Configured" : "Not set"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--ec-muted)]">Executable or app bundle</p>
        </div>
      </div>
      <Input
        className="mt-3 h-9 font-mono text-xs"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={idePathPlaceholder(kind)}
        spellCheck={false}
      />
      {canBrowseHostPaths ? <Button type="button" variant="secondary" size="sm" className="mt-2 h-8 w-full" disabled={saving} onClick={() => void onPickExecutable()}>
        Browse...
      </Button> : null}
    </div>
  );
};

export type UserSettingsTabProps = {
  busy: boolean;
  uiTheme: UiTheme;
  sidebarContrast: boolean;
  enableDevMode: boolean;
  appLogDirPath: string;
  appLogDirectorySize: AppLogDirectorySizeInfo;
  ideDraft: Partial<Record<SupportedIdeKind, string>>;
  idePathsDirty: boolean;
  idePathsSaving: boolean;
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
  onUiThemeChange: (theme: UiTheme) => void;
  onSidebarContrastChange: (value: boolean) => void;
  onEnableDevModeChange: (value: boolean) => void;
  onKeyboardShortcutChange: (id: KeyboardShortcutId, value: string) => void;
  onOpenAppLogDirectory: () => void | Promise<void>;
  onResetDatabase: () => void | Promise<void>;
  onIdeDraftChange: (next: Partial<Record<SupportedIdeKind, string>>) => void;
  onSaveIdePaths: () => void | Promise<void>;
  onResetIdeDraft: () => void;
  onPickIdeExecutable: (kind: SupportedIdeKind) => void | Promise<void>;
  nativeActions: boolean;
};

export const UserSettingsTab = ({
  busy,
  uiTheme,
  sidebarContrast,
  enableDevMode,
  appLogDirPath,
  appLogDirectorySize,
  ideDraft,
  idePathsDirty,
  idePathsSaving,
  keyboardShortcuts,
  onUiThemeChange,
  onSidebarContrastChange,
  onEnableDevModeChange,
  onKeyboardShortcutChange,
  onOpenAppLogDirectory,
  onResetDatabase,
  onIdeDraftChange,
  onSaveIdePaths,
  onResetIdeDraft,
  onPickIdeExecutable,
  nativeActions,
}: UserSettingsTabProps) => (
  <div className="space-y-5">
    <SettingsSection title="Appearance">
      <SettingsRow
        title="Interface theme"
        description="Choose the dark or light liquid-glass shell. Same options appear at the top of the View menu."
        align="start"
      >
        <div className={`${rowControlClass} grid gap-2 sm:grid-cols-2`} role="radiogroup" aria-label="Interface appearance">
          {APPEARANCE_OPTIONS.map((opt) => {
            const selected = uiTheme === opt.value;
            return (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-md border px-3 py-2.5 transition ${
                  selected
                    ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] shadow-[var(--ec-action-shadow)]"
                    : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] hover:bg-[var(--ec-hover)]"
                }`}
              >
                <input className="sr-only" type="radio" name="buildwarden-ui-theme" checked={selected} onChange={() => onUiThemeChange(opt.value)} />
                <p className="text-sm font-medium text-[var(--ec-text)]">{opt.label}</p>
                <p className="mt-1 text-xs leading-snug text-[var(--ec-muted)]">{opt.hint}</p>
              </label>
            );
          })}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Sidebar contrast"
        description="Give the sidebar its own surface color: slightly brighter and blue-tinted in dark mode, and slightly darker in light mode."
      >
        <div className={`${rowControlClass} flex items-center justify-end gap-3`}>
          <span className="text-xs font-medium text-[var(--ec-muted)]">{sidebarContrast ? "On" : "Off"}</span>
          <Switch
            checked={sidebarContrast}
            onCheckedChange={onSidebarContrastChange}
            disabled={busy}
            aria-label="Use contrasting sidebar surface"
          />
        </div>
      </SettingsRow>
    </SettingsSection>

    {nativeActions ? <SettingsSection title="External editors">
      <SettingsRow
        title="IDE executable paths"
        description={
          <>
            Point each IDE at its executable. On Windows use{" "}
            <code className="rounded bg-[var(--ec-control)] px-1 py-0.5 font-mono text-[var(--ec-text)]">.exe</code>; on macOS choose the{" "}
            <code className="rounded bg-[var(--ec-control)] px-1 py-0.5 font-mono text-[var(--ec-text)]">.app</code> bundle. Only configured editors
            appear when opening a run workspace from the run page.
          </>
        }
        align="start"
      >
        <div className={`${rowControlClass} space-y-3`}>
          <div className="grid gap-3">
            {SUPPORTED_IDE_KINDS.map((kind) => {
              const value = ideDraft[kind] ?? "";
              return (
                <EditorPathCard
                  key={kind}
                  kind={kind}
                  value={value}
                  saving={idePathsSaving}
                  onValueChange={(nextValue) => {
                    const next = { ...ideDraft };
                    if (!nextValue.trim()) {
                      delete next[kind];
                    } else {
                      next[kind] = nextValue;
                    }
                    onIdeDraftChange(next);
                  }}
                  onPickExecutable={() => onPickIdeExecutable(kind)}
                  canBrowseHostPaths={nativeActions}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
            <Button type="button" variant="secondary" size="sm" disabled={!idePathsDirty || idePathsSaving} onClick={onResetIdeDraft}>
              Reset
            </Button>
            <Button type="button" size="sm" disabled={!idePathsDirty || idePathsSaving} onClick={() => void onSaveIdePaths()}>
              {idePathsSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save IDE paths"
              )}
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection> : null}

    <SettingsSection title="Keyboard shortcuts">
      <SettingsRow
        title="Shortcut bindings"
        description="Customize key combinations for common actions. Click a field and press the desired keys. Shortcuts that apply only on certain screens are noted in the label."
        align="start"
      >
        <div className={`${rowControlClass} overflow-hidden rounded-md border border-[var(--ec-border)]`}>
          {KEYBOARD_SHORTCUT_IDS.map((id) => (
            <ShortcutRow key={id} label={SHORTCUT_LABELS[id]} value={keyboardShortcuts[id]} onChange={(value) => onKeyboardShortcutChange(id, value)} />
          ))}
        </div>
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Diagnostics">
      <SettingsRow
        title="Provider request logging"
        description="Disabled by default. When enabled, BuildWarden writes provider API requests and responses to local log files for debugging."
        align="start"
      >
        <div className={rowControlClass}>
          <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--ec-text)]">Write request/response logs</p>
                <p className="mt-1 text-xs text-[var(--ec-muted)]">
                  Logs are stored locally and can become verbose. Turn this on only when you need debugging details.
                </p>
              </div>
              <Switch checked={enableDevMode} onCheckedChange={onEnableDevModeChange} aria-label="Write request and response logs" />
            </div>
            <div className="mt-3 flex min-w-0 flex-col gap-2 border-t border-[var(--ec-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium text-[var(--ec-text)]">Log folder</p>
                  <span className="rounded bg-[var(--ec-control)] px-2 py-0.5 text-[11px] font-medium text-[var(--ec-muted)]">
                    {formatLogDirectorySize(appLogDirectorySize)}
                  </span>
                </div>
                {appLogDirPath ? (
                  <code className="mt-1 block max-w-full truncate rounded bg-[var(--ec-control)] px-2 py-1 text-xs text-[var(--ec-muted)]">{appLogDirPath}</code>
                ) : (
                  <span className="mt-1 block text-xs text-[var(--ec-muted)]">Log folder unavailable</span>
                )}
              </div>
              {nativeActions ? <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                disabled={!appLogDirPath}
                onClick={() => void onOpenAppLogDirectory()}
              >
                Open log folder
              </Button> : null}
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>

    {nativeActions ? <SettingsSection title="Data">
      <SettingsRow
        title="Clear database"
        description="Permanently delete all projects, runs, bookmarks, providers, models, and settings. The app will restart with a fresh database. This cannot be undone."
      >
        <div className={`${rowControlClass} flex justify-start md:justify-end`}>
          <Button
            variant="danger"
            size="sm"
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
      </SettingsRow>
    </SettingsSection> : null}
  </div>
);
