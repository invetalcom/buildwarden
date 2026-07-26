import { APP_SETTING_KEYS, parseUiTheme, uiThemeToLegacyDarkMode, type UiTheme } from "@buildwarden/shared";
import { APP_VERSION, APP_VERSION_DATE, PROVIDER_TYPE_LABELS } from "@buildwarden/renderer/logic";
import { ChevronLeft, Moon, Smartphone, Sun } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAction } from "../data/use-action";
import { switchShell } from "../../shell/select-shell";
import type { SettingsSection } from "../nav/mobile-router";
import { AppBar } from "../components/AppBar";
import { Badge, Divider, InlineError, ListRow, SectionLabel } from "../components/primitives";
import { cn } from "../lib/cn";

const SECTION_TITLES: Record<SettingsSection, string> = {
  appearance: "Appearance",
  models: "Providers & models",
  workspace: "Git & workspace",
  session: "Session",
  about: "About",
};

const ThemeChoice = ({ theme, current, onSelect }: { theme: UiTheme; current: UiTheme; onSelect: (next: UiTheme) => void }) => (
  <button
    type="button"
    onClick={() => onSelect(theme)}
    className={cn(
      "m-tap flex flex-1 flex-col items-center justify-center gap-1 rounded-md border transition",
      theme === current ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "border-[var(--ec-border)] text-[var(--ec-muted)]",
    )}
  >
    {theme === "light" ? <Sun className="size-5" /> : <Moon className="size-5" />}
    <span className="text-xs font-medium capitalize">{theme}</span>
  </button>
);

/**
 * Settings as an iOS-style grouped list that pushes sub-pages, rather than the desktop's tabbed
 * settings surface. Only settings that make sense from a phone are exposed; provider credentials
 * and binary paths stay on the desktop app, which is where the filesystem is.
 */
export const SettingsScreen = ({ section }: { section?: SettingsSection }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const action = useAction();
  const theme = parseUiTheme(snapshot.settings);
  const canWriteSettings = client.capabilities.settings;

  const setTheme = async (next: UiTheme) => {
    await action.run(async () => {
      await client.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
      await client.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
    }, "Could not save the theme.");
    await snapshotStore.refresh();
  };

  if (!section) {
    return (
      <>
        <AppBar title="Settings" onBack={router.back} />
        <div className="m-scroll m-screen-enter flex-1">
          {(["appearance", "models", "workspace", "session", "about"] as const).map((entry, index) => (
            <div key={entry}>
              {index > 0 ? <Divider /> : null}
              <ListRow title={SECTION_TITLES[entry]} onClick={() => router.push({ name: "settings", section: entry })} />
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <AppBar
        title={SECTION_TITLES[section]}
        leading={
          <button type="button" onClick={router.back} aria-label="Back" className="m-tap flex size-11 items-center justify-center text-[var(--ec-muted)]">
            <ChevronLeft className="size-6" />
          </button>
        }
      />

      <div className="m-scroll m-screen-enter flex-1">
        {action.error ? <InlineError message={action.error} /> : null}

        {section === "appearance" ? (
          <>
            <SectionLabel>Theme</SectionLabel>
            <div className="flex gap-2 px-4 pb-2">
              <ThemeChoice theme="dark" current={theme} onSelect={(next) => void setTheme(next)} />
              <ThemeChoice theme="light" current={theme} onSelect={(next) => void setTheme(next)} />
            </div>
            {!canWriteSettings ? (
              <p className="px-4 pb-2 text-[11px] text-[var(--ec-faint)]">
                This session was paired without the admin scope, so the theme cannot be saved to the host.
              </p>
            ) : null}
            <SectionLabel>Layout</SectionLabel>
            <ListRow
              leading={<Smartphone className="size-5" />}
              title="Use the desktop layout"
              subtitle="Reloads this browser with the full desktop UI"
              onClick={() => switchShell(window, "desktop")}
            />
          </>
        ) : null}

        {section === "models" ? (
          <>
            <SectionLabel>Providers</SectionLabel>
            {snapshot.providerAccounts.length === 0 ? (
              <p className="px-4 py-3 text-xs text-[var(--ec-muted)]">No providers configured.</p>
            ) : (
              snapshot.providerAccounts.map((account) => (
                <ListRow
                  key={account.id}
                  title={account.label || PROVIDER_TYPE_LABELS[account.providerType]}
                  subtitle={account.apiBaseUrl ?? PROVIDER_TYPE_LABELS[account.providerType]}
                  className="border-b border-[var(--ec-border)]"
                />
              ))
            )}
            <SectionLabel>Models</SectionLabel>
            {snapshot.models.map((model) => (
              <ListRow
                key={model.id}
                title={model.displayName || model.modelId}
                subtitle={model.modelId}
                trailing={model.enabled === 0 ? <Badge tone="neutral">off</Badge> : undefined}
                className="border-b border-[var(--ec-border)]"
              />
            ))}
            <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
              Adding providers needs API keys and local binary paths, so it stays in the desktop app.
            </p>
          </>
        ) : null}

        {section === "workspace" ? (
          <>
            <SectionLabel>Projects</SectionLabel>
            {snapshot.projects.map((entry) => (
              <ListRow
                key={entry.project.id}
                title={entry.project.name}
                subtitle={`Base branch: ${entry.project.baseBranch}`}
                onClick={() => router.push({ name: "project", projectId: entry.project.id, tab: "overview" })}
                className="border-b border-[var(--ec-border)]"
              />
            ))}
          </>
        ) : null}

        {section === "session" ? (
          <>
            <SectionLabel>This browser session</SectionLabel>
            <ListRow title="Control" trailing={client.capabilities.mutations ? "Read / write" : "Read only"} />
            <Divider />
            <ListRow title="Live events" trailing={client.capabilities.liveEvents ? "Streaming" : "Polling"} />
            <Divider />
            <ListRow title="Run actions" trailing={client.capabilities.runMutations ? "Allowed" : "Blocked"} />
            <Divider />
            <ListRow title="Git actions" trailing={client.capabilities.gitMutations ? "Allowed" : "Blocked"} />
            <Divider />
            <ListRow title="Shell approvals" trailing={client.capabilities.approvalResponses ? "Allowed" : "Blocked"} />
            <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
              Scopes are chosen when the pairing code is created on the desktop app. Pair again to change them.
            </p>
          </>
        ) : null}

        {section === "about" ? (
          <>
            <SectionLabel>Version</SectionLabel>
            <ListRow title="BuildWarden" trailing={APP_VERSION} />
            <Divider />
            <ListRow title="Released" trailing={APP_VERSION_DATE} />
            <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
              The desktop host stays authoritative. This browser only mirrors it; nothing is stored on a server.
            </p>
          </>
        ) : null}

        <div className="h-6" />
      </div>
    </>
  );
};
