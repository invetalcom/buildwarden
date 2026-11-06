import { useEffect, useState } from "react";
import { APP_SETTING_KEYS, type TerminalSettings, type TerminalShell } from "@buildwarden/shared";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";
import { Select } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settings-layout";

export function TerminalSettingsSection({ disabled }: { disabled?: boolean }) {
  const client = useOptionalBuildWardenClient();
  const [settings, setSettings] = useState<TerminalSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    setSettings(null); setError("");
    if (client?.getTerminalSettings) {
      void client.getTerminalSettings().then((value) => { if (!disposed) setSettings(value); })
        .catch((caught: unknown) => { if (!disposed) setError(String(caught)); });
    }
    return () => { disposed = true; };
  }, [client]);
  const save = async (value: string) => {
    if (!client || !settings || saving) return;
    setSaving(true); setError("");
    try {
      await client.setAppSetting(APP_SETTING_KEYS.terminalDefaultShell, value);
      setSettings({ ...settings, defaultShell: value as TerminalShell });
    } catch (caught) { setError(String(caught)); }
    finally { setSaving(false); }
  };
  return <SettingsSection title="Terminal">
    <SettingsRow title="Default shell" description="Opening a run’s terminal panel starts this shell when no terminal exists. System default uses the host’s configured shell. Existing terminals keep their shell.">
      <Select ariaLabel="Default terminal shell" value={settings?.defaultShell ?? "auto"}
        options={(settings?.shells ?? ["auto"]).map((value) => ({ value, label: value === "auto" ? "System default" : value }))}
        disabled={disabled || saving || !settings || !client?.capabilities.settings}
        onValueChange={(value) => void save(value)} className="max-w-xs" triggerClassName="h-8 text-xs" optionClassName="text-xs" />
      {error && <p role="alert" className="mt-1 text-xs text-[var(--ec-danger)]">{error}</p>}
    </SettingsRow>
  </SettingsSection>;
}
