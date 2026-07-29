import { APP_SETTING_KEYS, parseUiTheme, uiThemeToLegacyDarkMode, type UiTheme } from "@buildwarden/shared";
import { APP_VERSION, APP_VERSION_DATE } from "@buildwarden/renderer/logic";
import { ChevronLeft, Moon, Smartphone, Sun } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAppSettings } from "../data/use-app-settings";
import { switchShell } from "../../shell/select-shell";
import type { SettingsSection } from "../nav/mobile-router";
import { AppBar } from "../components/AppBar";
import { SettingGroup, ToggleRow } from "../components/SettingControls";
import { Divider, InlineError, ListRow } from "../components/primitives";
import { cn } from "../lib/cn";
import { NetworkSection } from "./settings/NetworkSection";
import { OrchestrationSection } from "./settings/OrchestrationSection";
import { ProvidersSection } from "./settings/ProvidersSection";
import { SkillsSection } from "./settings/SkillsSection";
import { WorkspaceSection } from "./settings/WorkspaceSection";

const SECTIONS: ReadonlyArray<{ id: SettingsSection; title: string; hint: string }> = [
  { id: "appearance", title: "Appearance", hint: "Theme and layout" },
  { id: "models", title: "Providers & models", hint: "Configured models" },
  { id: "workspace", title: "Projects & workspace", hint: "Branches, worktrees, shell allow-list" },
  { id: "skills", title: "Skills", hint: "Guidance available to runs" },
  { id: "orchestration", title: "Orchestration", hint: "Delegated agent limits and roles" },
  { id: "network", title: "Network", hint: "Outbound proxy" },
  { id: "session", title: "Session", hint: "What this browser may do" },
  { id: "about", title: "About", hint: "Version" },
];

const SECTION_TITLES = Object.fromEntries(SECTIONS.map((entry) => [entry.id, entry.title])) as Record<SettingsSection, string>;

const ThemeChoice = ({ theme, current, onSelect }: { theme: UiTheme; current: UiTheme; onSelect: (next: UiTheme) => void }) => (
  <button
    type="button"
    onClick={() => onSelect(theme)}
    className={cn(
      "m-tap flex flex-1 flex-col items-center justify-center gap-1 rounded-md border py-2 transition",
      theme === current
        ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
        : "border-[var(--ec-border)] text-[var(--ec-muted)]",
    )}
  >
    {theme === "light" ? <Sun className="size-5" /> : <Moon className="size-5" />}
    <span className="text-xs font-medium capitalize">{theme}</span>
  </button>
);

const AppearanceSection = () => {
  const { snapshot, snapshotStore, client } = useMobileApp();
  const settings = useAppSettings();
  const theme = parseUiTheme(snapshot.settings);

  const setTheme = async (next: UiTheme) => {
    const ok = await settings.writeMany([
      [APP_SETTING_KEYS.uiTheme, next],
      [APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next)],
    ]);
    if (ok) await snapshotStore.refresh();
  };

  return (
    <>
      {settings.error ? <InlineError message={settings.error} onRetry={settings.clearError} /> : null}
      <SettingGroup title="Theme">
        <div className="flex gap-2 px-4 py-2.5">
          <ThemeChoice theme="dark" current={theme} onSelect={(next) => void setTheme(next)} />
          <ThemeChoice theme="light" current={theme} onSelect={(next) => void setTheme(next)} />
        </div>
      </SettingGroup>

      <SettingGroup title="Advanced">
        <ToggleRow
          title="Developer mode"
          description="Shows extra diagnostics across the app."
          checked={settings.read(APP_SETTING_KEYS.enableDevMode) === "true"}
          disabled={!settings.canWrite || settings.saving}
          onChange={(next) => void settings.write(APP_SETTING_KEYS.enableDevMode, String(next))}
        />
      </SettingGroup>

      <SettingGroup title="Layout" hint="Keyboard shortcuts and IDE integrations apply to the desktop app only.">
        <ListRow
          leading={<Smartphone className="size-5" />}
          title="Use the desktop layout"
          subtitle="Reloads this browser with the full desktop UI"
          onClick={() => switchShell(window, "desktop")}
        />
      </SettingGroup>

      {!client.capabilities.settings ? (
        <p className="px-4 py-3 text-[11px] leading-4 text-[var(--ec-warning)]">
          This session was paired without the admin scope, so changes cannot be saved to the host.
        </p>
      ) : null}
      <div className="h-6" />
    </>
  );
};

const SessionSection = () => {
  const { client } = useMobileApp();
  const rows: Array<[string, string]> = [
    ["Control", client.capabilities.mutations ? "Read / write" : "Read only"],
    ["Live events", client.capabilities.liveEvents ? "Streaming" : "Polling"],
    ["Run actions", client.capabilities.runMutations ? "Allowed" : "Blocked"],
    ["Chat actions", client.capabilities.chatMutations ? "Allowed" : "Blocked"],
    ["Git actions", client.capabilities.gitMutations ? "Allowed" : "Blocked"],
    ["Shell approvals", client.capabilities.approvalResponses ? "Allowed" : "Blocked"],
    ["Settings", client.capabilities.settings ? "Allowed" : "Blocked"],
    ["Add projects", client.capabilities.projectCreation ? "Allowed" : "Blocked"],
    ["Orchestration", client.capabilities.orchestrationOperate ? "Allowed" : "Read only"],
    ["Terminal", client.capabilities.embeddedTerminal ? "Allowed" : "Blocked"],
  ];

  return (
    <>
      <SettingGroup title="This browser session">
        {rows.map(([label, value]) => (
          <ListRow key={label} title={label} trailing={value} className="border-b border-[var(--ec-border)] last:border-b-0" />
        ))}
      </SettingGroup>
      <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
        Scopes are chosen when the pairing code is created on the desktop app. Pair again to change them.
      </p>
    </>
  );
};

/**
 * Settings as an iOS-style grouped list that pushes sub-pages, rather than the desktop's tabbed
 * settings surface. Everything the host exposes over a remote session is here; host-machine-only
 * controls (IDE paths, log folder, keyboard shortcuts, database reset, remote-access pairing) are
 * absent because the remote API does not offer them to a paired browser.
 */
export const SettingsScreen = ({ section }: { section?: SettingsSection }) => {
  const { router } = useMobileApp();

  if (!section) {
    return (
      <>
        <AppBar title="Settings" onBack={router.back} />
        <div className="m-scroll m-screen-enter flex-1">
          {SECTIONS.map((entry, index) => (
            <div key={entry.id}>
              {index > 0 ? <Divider /> : null}
              <ListRow
                title={entry.title}
                subtitle={entry.hint}
                onClick={() => router.push({ name: "settings", section: entry.id })}
              />
            </div>
          ))}
          <div className="h-6" />
        </div>
      </>
    );
  }

  return (
    <>
      <AppBar
        title={SECTION_TITLES[section]}
        leading={
          <button
            type="button"
            onClick={router.back}
            aria-label="Back"
            className="m-tap flex size-11 items-center justify-center text-[var(--ec-muted)]"
          >
            <ChevronLeft className="size-6" />
          </button>
        }
      />

      <div className="m-scroll m-screen-enter flex-1">
        {section === "appearance" ? <AppearanceSection /> : null}
        {section === "models" ? <ProvidersSection /> : null}
        {section === "workspace" ? <WorkspaceSection /> : null}
        {section === "skills" ? <SkillsSection /> : null}
        {section === "orchestration" ? <OrchestrationSection /> : null}
        {section === "network" ? <NetworkSection /> : null}
        {section === "session" ? <SessionSection /> : null}
        {section === "about" ? (
          <>
            <SettingGroup title="Version">
              <ListRow title="BuildWarden" trailing={APP_VERSION} className="border-b border-[var(--ec-border)]" />
              <ListRow title="Released" trailing={APP_VERSION_DATE} />
            </SettingGroup>
            <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
              The desktop host stays authoritative. This browser only mirrors it; nothing is stored on a server.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
};
