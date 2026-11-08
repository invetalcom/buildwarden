import { useState } from "react";
import { APP_SETTING_KEYS, type ModelRecord } from "@buildwarden/shared";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

export interface SessionTitleSettingsProps {
  enabled: boolean;
  modelId: string;
  instructions: string;
  models: ModelRecord[];
  onChange: (key: string, value: string) => Promise<void>;
}

export const SessionTitleSettings = ({ enabled, modelId, instructions, models, onChange }: SessionTitleSettingsProps) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftState, setDraft] = useState({ source: instructions, value: instructions });
  const draft = draftState.source === instructions ? draftState.value : instructions;
  const save = async (key: string, value: string) => {
    setSaving(true);
    setError(null);
    try { await onChange(key, value); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  return <div className="w-full space-y-2 md:max-w-[42rem]">
    <div className="flex justify-start md:justify-end">
      <Switch checked={enabled} disabled={saving} aria-label="Run and chat titles"
        onCheckedChange={(value) => void save(APP_SETTING_KEYS.sessionTitlesEnabled, String(value))} />
    </div>
    {enabled ? <details className="text-xs text-[var(--ec-muted)]">
      <summary className="cursor-pointer text-right">Title options</summary>
      <div className="mt-2 space-y-2">
        <label className="flex items-center gap-2">Model
          <select aria-label="Title generation model" value={modelId} disabled={saving}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 text-[var(--ec-text)]"
            onChange={(event) => void save(APP_SETTING_KEYS.sessionTitleModelId, event.target.value)}>
            <option value="">Use the run or chat model</option>
            {modelId && !models.some((model) => model.id === modelId) ? <option value={modelId}>Unavailable model</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <Input aria-label="Title instructions" placeholder="Optional title instructions" maxLength={2000}
            value={draft} onChange={(event) => setDraft({ source: instructions, value: event.target.value })} className="h-8 text-xs" />
          <Button size="sm" disabled={saving || draft === instructions} onClick={() => void save(APP_SETTING_KEYS.sessionTitleInstructions, draft)}>Save</Button>
        </div>
      </div>
    </details> : null}
    {error ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
  </div>;
};
