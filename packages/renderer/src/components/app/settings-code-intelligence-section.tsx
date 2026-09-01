import {
  CODE_INTELLIGENCE_TOOL_NAMES,
  PROVIDER_TYPES,
  type CodeIntelligenceSettings,
  type CodeIntelligenceToolName,
  type ProviderType,
} from "@buildwarden/shared";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { PROVIDER_TYPE_LABELS } from "./provider-model-labels";

const OPERATION_DETAILS: Record<CodeIntelligenceToolName, { label: string; description: string }> = {
  codebase_map: { label: "Codebase map", description: "Gives the agent a quick overview of important files, classes, functions, and connections." },
  search_symbols: { label: "Search symbols", description: "Finds classes, functions, methods, and other named parts of the code." },
  file_outline: { label: "File outline", description: "Shows what is defined in a file and where each item starts and ends." },
  read_symbol: { label: "Read symbol", description: "Reads only the code for a selected class, function, or other named item." },
  resolve_symbol: { label: "Resolve symbol", description: "Finds the most likely definition when the same name appears in several places." },
  find_references: { label: "Find references", description: "Looks for places where a class, function, or variable name is used." },
  dependency_edges: { label: "Dependency edges", description: "Shows which files and packages are imported, included, or required." },
};

const withProviderTools = (
  settings: CodeIntelligenceSettings,
  providerType: ProviderType,
  enabledTools: readonly CodeIntelligenceToolName[],
): CodeIntelligenceSettings => {
  const next = { ...settings };
  if (enabledTools.length === 0) {
    delete next[providerType];
  } else {
    next[providerType] = Object.fromEntries(enabledTools.map((toolName) => [toolName, true]));
  }
  return next;
};

export const CodeIntelligenceSettingsSection = ({
  settings,
  onChange,
}: {
  settings: CodeIntelligenceSettings;
  onChange: (settings: CodeIntelligenceSettings) => void | Promise<void>;
}) => {
  const [providerType, setProviderType] = useState<ProviderType>("ai-sdk");
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings]);

  const enabledTools = CODE_INTELLIGENCE_TOOL_NAMES.filter((toolName) => draft[providerType]?.[toolName] === true);
  const commit = (next: CodeIntelligenceSettings) => {
    setDraft(next);
    void onChange(next);
  };

  return (
    <Card className="app-surface-settings-form-card overflow-hidden p-0">
      <div className="border-b border-[var(--ec-border)] px-5 py-3">
        <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--ec-accent)]">Agent tools</p>
        <h3 className="mt-1 text-lg font-semibold text-[var(--ec-text)]">Code intelligence operations</h3>
        <p className="mt-1 max-w-4xl text-sm leading-5 text-[var(--ec-muted)]">
          These optional tools help coding agents navigate your project by classes, functions, and imports instead of
          searching through files one at a time. This can make them faster and reduce how much code they need to read.
          Choose a provider below and enable only the tools you want; leaving everything off keeps its current behavior.
        </p>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="min-w-56 space-y-1.5">
            <span className="block text-sm font-medium text-[var(--ec-text)]">Configure provider</span>
            <Select
              value={providerType}
              onValueChange={(value) => setProviderType(value as ProviderType)}
              options={PROVIDER_TYPES.map((value) => ({ value, label: PROVIDER_TYPE_LABELS[value] }))}
              triggerClassName="h-9 rounded-lg"
            />
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => commit(withProviderTools(draft, providerType, CODE_INTELLIGENCE_TOOL_NAMES))}
            >
              Enable all
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => commit(withProviderTools(draft, providerType, []))}
              disabled={enabledTools.length === 0}
            >
              Disable all
            </Button>
          </div>
        </div>

        <div className="divide-y divide-[var(--ec-border)] rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)]">
          {CODE_INTELLIGENCE_TOOL_NAMES.map((toolName) => {
            const detail = OPERATION_DETAILS[toolName];
            const checked = draft[providerType]?.[toolName] === true;
            return (
              <div key={toolName} className="flex items-center gap-3 px-3 py-2.5">
                <Switch
                  checked={checked}
                  aria-label={`${detail.label} for ${PROVIDER_TYPE_LABELS[providerType]}`}
                  onCheckedChange={(enabled) => {
                    const nextTools = enabled
                      ? [...enabledTools, toolName]
                      : enabledTools.filter((candidate) => candidate !== toolName);
                    commit(withProviderTools(draft, providerType, nextTools));
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-[var(--ec-text)]">{detail.label}</span>
                    <code className="text-[11px] text-[var(--ec-faint)]">{toolName}</code>
                  </div>
                  <p className="text-xs leading-5 text-[var(--ec-muted)]">{detail.description}</p>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs leading-5 text-[var(--ec-muted)]">
          All analysis runs locally on your computer. Results are best-effort, so agents should still verify important
          matches before editing code.
        </p>
      </div>
    </Card>
  );
};
