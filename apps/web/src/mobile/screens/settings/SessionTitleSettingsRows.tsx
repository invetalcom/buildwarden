import { APP_SETTING_KEYS, type ModelRecord } from "@buildwarden/shared";
import type { AppSettingsWriter } from "../../data/use-app-settings";
import { SelectRow, TextRow, ToggleRow } from "../../components/SettingControls";

export const SessionTitleSettingsRows = ({ settings, models }: { settings: AppSettingsWriter; models: ModelRecord[] }) => {
  const enabled = settings.read(APP_SETTING_KEYS.sessionTitlesEnabled) !== "false";
  const modelId = settings.read(APP_SETTING_KEYS.sessionTitleModelId) ?? "";
  const available = models.filter((model) => model.enabled);
  const disabled = !settings.canWrite || settings.saving;
  return <>
    <ToggleRow title="Run and chat titles"
      description="Generate short titles for new runs and chats. Turning this off shows prompts and keeps saved titles."
      checked={enabled} disabled={disabled}
      onChange={(next) => void settings.write(APP_SETTING_KEYS.sessionTitlesEnabled, String(next))} />
    {enabled ? <details className="border-b border-[var(--ec-border)] last:border-b-0">
      <summary className="m-tap cursor-pointer px-4 py-3 text-xs text-[var(--ec-muted)]">Title options</summary>
      <SelectRow title="Title generation model" value={modelId} disabled={disabled}
        options={[
          { value: "", label: "Use the run or chat model" },
          ...(modelId && !available.some((model) => model.id === modelId) ? [{ value: modelId, label: "Unavailable model" }] : []),
          ...available.map((model) => ({ value: model.id, label: model.displayName })),
        ]}
        onChange={(value) => void settings.write(APP_SETTING_KEYS.sessionTitleModelId, value)} />
      <TextRow title="Title instructions" placeholder="Optional title instructions" disabled={disabled}
        value={settings.read(APP_SETTING_KEYS.sessionTitleInstructions) ?? ""}
        invalid={(value) => value.length > 2000 ? "Use at most 2000 characters." : null}
        onCommit={(value) => void settings.write(APP_SETTING_KEYS.sessionTitleInstructions, value)} />
    </details> : null}
  </>;
};
