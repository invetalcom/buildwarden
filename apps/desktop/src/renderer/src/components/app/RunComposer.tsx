import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { RunMode, RunWorkspaceType, UnifiedProviderFamily, ProviderType } from "@easycode/shared";
import { ArrowUp, Bot, BrainCircuit, Check, ChevronDown, GitBranch, ShieldOff, SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ContextWindowBadge } from "./ContextWindowBadge";

const RUN_MODES: RunMode[] = ["code", "plan", "ask"];

function collectFilesFromClipboardData(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  // Prefer `files` only when non-empty: Chromium/Electron often mirror the same paste in both
  // `files` and `items`, and `getAsFile()` can differ slightly in `lastModified`, defeating dedupe.
  const list = data.files;
  if (list?.length) {
    return Array.from(list);
  }
  const out: File[] = [];
  for (let i = 0; i < data.items.length; i += 1) {
    const item = data.items[i];
    if (item?.kind === "file") {
      const f = item.getAsFile();
      if (f) {
        out.push(f);
      }
    }
  }
  return out;
}

const MODE_LABELS: Record<RunMode, string> = {
  ask: "Ask",
  code: "Code",
  plan: "Plan",
};

interface ComposerSelectOption {
  value: string;
  label: string;
  displayLabel?: string;
  contextModelId?: string;
  providerType?: ProviderType;
  providerFamily?: UnifiedProviderFamily | null;
}

interface ComposerSelectProps {
  value: string;
  icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  options: ComposerSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  buttonClassName?: string;
  menuClassName?: string;
  menuSide?: "top" | "bottom";
  selectedIconClassName?: string;
}

export const ComposerSelect = ({
  value,
  icon: Icon,
  iconClassName,
  options,
  onChange,
  disabled = false,
  buttonClassName = "",
  menuClassName = "",
  menuSide = "top",
  selectedIconClassName = "text-cyan-300",
}: ComposerSelectProps) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${open ? "z-[80]" : "z-10"}`}>
      <button
        type="button"
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2 text-xs text-zinc-300 transition hover:border-white/10 hover:bg-white/5 disabled:pointer-events-none disabled:opacity-50 ${buttonClassName}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || options.length === 0}
      >
        <Icon className={`h-3.5 w-3.5 ${iconClassName}`} />
        <span className="max-w-[14rem] truncate text-zinc-200">{selectedOption?.displayLabel ?? selectedOption?.label ?? "Select"}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`app-composer-dropdown-panel app-scrollbar absolute left-0 z-[90] max-h-72 min-w-full overflow-auto rounded-xl border border-zinc-800 p-1.5 shadow-2xl shadow-black/40 backdrop-blur ${
            menuSide === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
          } ${menuClassName}`}
        >
          {options.map((option) => {
            const isSelected = option.value === value;

            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                  isSelected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{option.label}</span>
                {isSelected ? <Check className={`h-3.5 w-3.5 shrink-0 ${selectedIconClassName}`} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

interface ComposerMultiModelSelectProps {
  selectedIds: string[];
  icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  options: ComposerSelectOption[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  buttonClassName?: string;
  menuClassName?: string;
  menuSide?: "top" | "bottom";
  selectedIconClassName?: string;
}

const ComposerMultiModelSelect = ({
  selectedIds,
  icon: Icon,
  iconClassName,
  options,
  onChange,
  disabled = false,
  buttonClassName = "",
  menuClassName = "",
  menuSide = "top",
  selectedIconClassName = "text-cyan-300",
}: ComposerMultiModelSelectProps) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = new Set(selectedIds);

  const summaryLabel = (() => {
    if (selectedIds.length === 0) {
      return "Select models";
    }
    if (selectedIds.length === 1) {
      const one = options.find((o) => o.value === selectedIds[0]);
      return one?.label ?? "1 model";
    }
    return `${selectedIds.length} models`;
  })();

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const toggleId = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      if (next.size <= 1) {
        return;
      }
      next.delete(id);
    } else {
      next.add(id);
    }
    const ordered = options.map((o) => o.value).filter((value) => next.has(value));
    onChange(ordered);
  };

  return (
    <div ref={rootRef} className={`relative ${open ? "z-[80]" : "z-10"}`}>
      <button
        type="button"
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2 text-xs text-zinc-300 transition hover:border-white/10 hover:bg-white/5 disabled:pointer-events-none disabled:opacity-50 ${buttonClassName}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || options.length === 0}
      >
        <Icon className={`h-3.5 w-3.5 ${iconClassName}`} />
        <span className="max-w-[14rem] truncate text-zinc-200">{summaryLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`app-composer-dropdown-panel app-scrollbar absolute left-0 z-[90] max-h-72 min-w-full overflow-auto rounded-xl border border-zinc-800 p-1.5 shadow-2xl shadow-black/40 backdrop-blur ${
            menuSide === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
          } ${menuClassName}`}
        >
          <p className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">Select one or more</p>
          {options.map((option) => {
            const isSelected = selectedSet.has(option.value);

            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                  isSelected ? "bg-zinc-800/80 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  toggleId(option.value);
                }}
              >
                <span className="truncate">{option.label}</span>
                {isSelected ? <Check className={`h-3.5 w-3.5 shrink-0 ${selectedIconClassName}`} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

const WORKSPACE_LABELS: Record<RunWorkspaceType, string> = {
  local: "Local",
  worktree: "Worktree",
};

const ComposerRunSettingsButton = ({
  selectedMode,
  onModeChange,
  selectedWorkspaceType,
  onWorkspaceTypeChange,
  selectedBranch,
  branchOptions,
  onBranchChange,
  branchDisabled,
  disabled,
  menuSide,
}: {
  selectedMode: RunMode;
  onModeChange: (mode: RunMode) => void;
  selectedWorkspaceType?: RunWorkspaceType;
  onWorkspaceTypeChange?: (value: RunWorkspaceType) => void;
  selectedBranch?: string;
  branchOptions?: ComposerSelectOption[];
  onBranchChange?: (branch: string) => void;
  branchDisabled?: boolean;
  disabled?: boolean;
  menuSide: "top" | "bottom";
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const workspaceLabel = selectedWorkspaceType ? WORKSPACE_LABELS[selectedWorkspaceType] : null;
  const summary = [MODE_LABELS[selectedMode], workspaceLabel, selectedBranch].filter(Boolean).join(" / ");

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const modeOptions = RUN_MODES.map((mode) => ({
    value: mode,
    label: MODE_LABELS[mode],
  }));
  const workspaceOptions = (["worktree", "local"] as const).map((value) => ({
    value,
    label: WORKSPACE_LABELS[value],
  }));

  return (
    <div ref={rootRef} className={`relative ${open ? "z-[80]" : "z-10"}`}>
      <button
        type="button"
        className="inline-flex h-7 max-w-[20rem] items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2 text-xs text-zinc-300 transition hover:border-white/10 hover:bg-white/5 disabled:pointer-events-none disabled:opacity-50"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-zinc-400" />
        <span className="truncate text-zinc-200">{summary || "Run settings"}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`app-composer-dropdown-panel app-scrollbar absolute left-0 z-[90] w-72 max-h-80 overflow-auto rounded-xl border border-zinc-800 p-2 shadow-2xl shadow-black/40 backdrop-blur ${
            menuSide === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
          }`}
        >
          <div className="space-y-2">
            <div>
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Mode</p>
              <div className="grid grid-cols-3 gap-1">
                {modeOptions.map((option) => {
                  const selected = option.value === selectedMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-lg px-2 py-1.5 text-xs transition ${
                        selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                      }`}
                      onClick={() => {
                        onModeChange(option.value as RunMode);
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedWorkspaceType && onWorkspaceTypeChange ? (
              <div>
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Workspace</p>
                <div className="grid grid-cols-2 gap-1">
                  {workspaceOptions.map((option) => {
                    const selected = option.value === selectedWorkspaceType;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`rounded-lg px-2 py-1.5 text-xs transition ${
                          selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                        }`}
                        onClick={() => {
                          onWorkspaceTypeChange(option.value);
                        }}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {selectedBranch != null && branchOptions?.length && onBranchChange ? (
              <div>
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Branch</p>
                <div className="max-h-36 overflow-auto pr-0.5">
                  {branchOptions.map((option) => {
                    const selected = option.value === selectedBranch;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                          selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                        } ${branchDisabled ? "pointer-events-none opacity-60" : ""}`}
                        onClick={() => {
                          onBranchChange(option.value);
                          setOpen(false);
                        }}
                        disabled={branchDisabled}
                      >
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                        <span className="truncate">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const eventToKeyString = (e: KeyboardEvent<HTMLTextAreaElement>): string => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (key === " ") parts.push("space");
  else if (!["control", "meta", "alt", "shift"].includes(key)) parts.push(key);
  return parts.join("+");
};

interface RunComposerProps {
  /** `chat` hides mode / workspace / branch controls (model + submit only). */
  variant?: "default" | "chat";
  /** Renders in the footer row to the left of Cancel / Send (e.g. file attachments). */
  attachments?: ReactNode;
  prompt: string;
  onPromptChange: (value: string) => void;
  selectedMode: RunMode;
  onModeChange: (mode: RunMode) => void;
  selectedModelId: string;
  modelOptions: ComposerSelectOption[];
  onModelChange: (modelId: string) => void;
  /** Worktree runs: allow multiple models (one run + worktree per model). */
  modelSelectionMode?: "single" | "multi";
  selectedModelIds?: string[];
  onModelIdsChange?: (modelIds: string[]) => void;
  selectedBranch?: string;
  branchOptions?: ComposerSelectOption[];
  onBranchChange?: (branch: string) => void;
  branchDisabled?: boolean;
  selectedWorkspaceType?: RunWorkspaceType;
  onWorkspaceTypeChange?: (value: RunWorkspaceType) => void;
  busy: boolean;
  isRunActive?: boolean;
  onCancel?: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  submitIcon?: ReactNode;
  placeholder?: string;
  dropdownSide?: "top" | "bottom";
  submitDisabled?: boolean;
  sticky?: boolean;
  /** Tighter padding and shorter default textarea min-height (e.g. agent run footer). */
  dense?: boolean;
  submitShortcut?: string;
  onPromptKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** When set, pasting files into the prompt (e.g. copied from Explorer/Finder) adds them like Attach; parent should merge with `appendChatAttachmentFiles` from `@easycode/shared`. */
  onAddAttachmentFiles?: (files: File[]) => void;
  textareaClassName?: string;
  autoFocus?: boolean;
  contextHistoryText?: string;
  contextAttachmentFiles?: File[];
  showContextBadge?: boolean;
  reasoningEffort?: string;
  anthropicEffort?: string;
  onReasoningEffortChange?: (value: string) => void;
  onAnthropicEffortChange?: (value: string) => void;
  yoloMode?: boolean;
  onYoloModeChange?: (value: boolean) => void;
}

export const RunComposer = ({
  variant = "default",
  attachments,
  prompt,
  onPromptChange,
  selectedMode,
  onModeChange,
  selectedModelId,
  modelOptions,
  onModelChange,
  modelSelectionMode = "single",
  selectedModelIds = [],
  onModelIdsChange,
  selectedBranch,
  branchOptions,
  onBranchChange,
  branchDisabled = false,
  selectedWorkspaceType,
  onWorkspaceTypeChange,
  busy,
  isRunActive = false,
  onCancel,
  onSubmit,
  submitLabel = "Send",
  submitIcon = <ArrowUp className="ml-2 h-4 w-4" />,
  placeholder = "Ask EasyCode to continue this run, refine the diff, fix a bug, or explain a change.",
  dropdownSide = "top",
  submitDisabled,
  sticky = true,
  dense = false,
  submitShortcut,
  onPromptKeyDown,
  onAddAttachmentFiles,
  textareaClassName = "",
  autoFocus = false,
  contextHistoryText,
  contextAttachmentFiles,
  showContextBadge = true,
  reasoningEffort = "",
  anthropicEffort = "",
  onReasoningEffortChange,
  onAnthropicEffortChange,
  yoloMode = false,
  onYoloModeChange,
}: RunComposerProps) => {
  const isChat = variant === "chat";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelSelectOptions = modelOptions;
  const multiModelChange = onModelIdsChange;
  const useMultiModel = !isChat && modelSelectionMode === "multi" && typeof multiModelChange === "function";
  const selectedContextModelIds = useMemo(() => {
    if (useMultiModel) {
      return modelSelectOptions
        .filter((option) => selectedModelIds.includes(option.value))
        .map((option) => option.contextModelId ?? option.value);
    }
    if (!selectedModelId) {
      return [];
    }
    const selectedOption = modelSelectOptions.find((option) => option.value === selectedModelId);
    return [selectedOption?.contextModelId ?? selectedModelId];
  }, [modelSelectOptions, selectedModelId, selectedModelIds, useMultiModel]);
  const activeModelOption = useMemo(() => {
    if (!useMultiModel) {
      return modelSelectOptions.find((option) => option.value === selectedModelId) ?? null;
    }
    const selectedOptions = modelSelectOptions.filter((option) => selectedModelIds.includes(option.value));
    if (selectedOptions.length === 0) {
      return null;
    }
    const first = selectedOptions[0]!;
    const uniform = selectedOptions.every(
      (option) => option.providerType === first.providerType && option.providerFamily === first.providerFamily,
    );
    return uniform ? first : null;
  }, [modelSelectOptions, selectedModelId, selectedModelIds, useMultiModel]);
  const selectedModelOptions = useMemo(
    () =>
      useMultiModel
        ? modelSelectOptions.filter((option) => selectedModelIds.includes(option.value))
        : modelSelectOptions.filter((option) => option.value === selectedModelId),
    [modelSelectOptions, selectedModelId, selectedModelIds, useMultiModel],
  );
  const supportsReasoning = (option: ComposerSelectOption) =>
    option.providerType === "codex-cli" ||
    option.providerType === "claude-code" ||
    (option.providerType === "ai-sdk" && (option.providerFamily === "openai" || option.providerFamily === "anthropic"));
  const showMultiReasoningControl =
    useMultiModel && selectedModelOptions.some(supportsReasoning) && (onReasoningEffortChange || onAnthropicEffortChange);
  const normalizedMultiReasoning = ["low", "medium", "high"].includes(reasoningEffort)
    ? reasoningEffort
    : ["low", "medium", "high"].includes(anthropicEffort)
      ? anthropicEffort
      : "medium";
  const showReasoningControl =
    !useMultiModel &&
    (activeModelOption?.providerType === "codex-cli" ||
      (activeModelOption?.providerType === "ai-sdk" && activeModelOption.providerFamily === "openai"));
  const showAnthropicControl =
    !useMultiModel &&
    (activeModelOption?.providerType === "claude-code" ||
      (activeModelOption?.providerType === "ai-sdk" && activeModelOption.providerFamily === "anthropic"));
  const reasoningSelectOptions =
    activeModelOption?.providerType === "ai-sdk" && activeModelOption.providerFamily === "openai"
      ? [
          { value: "none", label: "Reasoning: None", displayLabel: "None" },
          { value: "low", label: "Reasoning: Low", displayLabel: "Low" },
          { value: "medium", label: "Reasoning: Medium", displayLabel: "Medium" },
          { value: "high", label: "Reasoning: High", displayLabel: "High" },
          { value: "xhigh", label: "Reasoning: XHigh", displayLabel: "XHigh" },
        ]
      : [
          { value: "low", label: "Reasoning: Low", displayLabel: "Low" },
          { value: "medium", label: "Reasoning: Medium", displayLabel: "Medium" },
          { value: "high", label: "Reasoning: High", displayLabel: "High" },
          { value: "xhigh", label: "Reasoning: XHigh", displayLabel: "XHigh" },
        ];
  const branchSelectOptions = branchOptions?.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const modelOk = useMultiModel ? selectedModelIds.length > 0 : Boolean(selectedModelId);
  const isSubmitDisabled = submitDisabled ?? (busy || isRunActive || !prompt.trim() || !modelOk);
  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onPromptKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (!submitShortcut || isSubmitDisabled) {
      return;
    }
    if (eventToKeyString(event) !== submitShortcut) {
      return;
    }
    event.preventDefault();
    void onSubmit();
  };

  const handlePromptPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAddAttachmentFiles || busy || isRunActive) {
      return;
    }
    const pasted = collectFilesFromClipboardData(event.clipboardData);
    if (pasted.length === 0) {
      return;
    }
    event.preventDefault();
    onAddAttachmentFiles(pasted);
  };

  const textareaMinClass = isChat ? (dense ? "min-h-24 sm:min-h-32" : "min-h-28 sm:min-h-36") : dense ? "min-h-20" : "min-h-24";

  useEffect(() => {
    if (!autoFocus || busy || isRunActive) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [autoFocus, busy, isRunActive]);

  return (
    <div
      className={
        sticky
          ? "sticky bottom-0 z-10 pb-1"
          : /* In-flow composer: lift above following cards so dropdowns aren’t covered by later siblings (e.g. Chat search). */
            "relative z-20"
      }
    >
      <div className={dense ? "p-1" : "p-1.5"}>
        <div className="app-input-surface rounded-2xl border border-zinc-800 transition focus-within:border-cyan-500/80">
          <Textarea
            ref={textareaRef}
            className={`${textareaMinClass} !border-0 !bg-transparent resize-none rounded-2xl px-4 pb-1 pt-3 focus:!border-transparent ${textareaClassName}`.trim()}
            placeholder={placeholder}
            value={prompt}
            autoFocus={autoFocus}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            onPaste={handlePromptPaste}
            disabled={busy || isRunActive}
          />
          <div className="flex flex-col gap-1 px-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-0.5">
              {useMultiModel ? (
                <ComposerMultiModelSelect
                  selectedIds={selectedModelIds}
                  icon={Bot}
                  iconClassName="text-zinc-400"
                  options={modelSelectOptions}
                  onChange={multiModelChange}
                  disabled={busy}
                  menuClassName="w-[22rem]"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-zinc-200"
                />
              ) : (
                <ComposerSelect
                  value={selectedModelId}
                  icon={Bot}
                  iconClassName="text-zinc-400"
                  options={modelSelectOptions}
                  onChange={onModelChange}
                  disabled={busy}
                  menuClassName="w-[22rem]"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-zinc-200"
                />
              )}
              {showReasoningControl && onReasoningEffortChange ? (
                <ComposerSelect
                  value={reasoningEffort || "medium"}
                  icon={BrainCircuit}
                  iconClassName="text-zinc-400"
                  options={reasoningSelectOptions}
                  onChange={onReasoningEffortChange}
                  disabled={busy}
                  menuClassName="w-52"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-zinc-200"
                />
              ) : null}
              {showMultiReasoningControl ? (
                <ComposerSelect
                  value={normalizedMultiReasoning}
                  icon={BrainCircuit}
                  iconClassName="text-zinc-400"
                  options={[
                    { value: "low", label: "Reasoning: Low", displayLabel: "Low" },
                    { value: "medium", label: "Reasoning: Medium", displayLabel: "Medium" },
                    { value: "high", label: "Reasoning: High", displayLabel: "High" },
                  ]}
                  onChange={(value) => {
                    onReasoningEffortChange?.(value);
                    onAnthropicEffortChange?.(value);
                  }}
                  disabled={busy}
                  menuClassName="w-48"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-zinc-200"
                />
              ) : null}
              {showAnthropicControl && onAnthropicEffortChange ? (
                <ComposerSelect
                  value={anthropicEffort || "medium"}
                  icon={BrainCircuit}
                  iconClassName="text-zinc-400"
                  options={[
                    { value: "low", label: "Effort: Low", displayLabel: "Low" },
                    { value: "medium", label: "Effort: Medium", displayLabel: "Medium" },
                    { value: "high", label: "Effort: High", displayLabel: "High" },
                    ...(activeModelOption?.providerType === "claude-code"
                      ? [
                          { value: "xhigh", label: "Effort: XHigh", displayLabel: "XHigh" },
                          { value: "max", label: "Effort: Max", displayLabel: "Max" },
                        ]
                      : []),
                  ]}
                  onChange={onAnthropicEffortChange}
                  disabled={busy}
                  menuClassName="w-48"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-zinc-200"
                />
              ) : null}
              {!isChat ? (
                <ComposerRunSettingsButton
                  selectedMode={selectedMode}
                  onModeChange={onModeChange}
                  selectedWorkspaceType={selectedWorkspaceType}
                  onWorkspaceTypeChange={onWorkspaceTypeChange}
                  selectedBranch={selectedBranch}
                  branchOptions={branchSelectOptions}
                  onBranchChange={onBranchChange}
                  branchDisabled={branchDisabled}
                  disabled={busy}
                  menuSide={dropdownSide}
                />
              ) : null}
              {!isChat && onYoloModeChange ? (
                <button
                  type="button"
                  aria-pressed={yoloMode}
                  title={
                    yoloMode
                      ? "Full access on: Easycode will not ask before tools or shell commands."
                      : "Full access off: Easycode will ask before untrusted tools or shell commands."
                  }
                  disabled={busy}
                  onClick={() => onYoloModeChange(!yoloMode)}
                  className={[
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2 text-xs font-medium transition hover:border-white/10 hover:bg-white/5",
                    yoloMode ? "text-rose-200" : "text-zinc-300",
                    busy ? "cursor-not-allowed opacity-60" : "",
                  ].join(" ")}
                >
                  <ShieldOff className={["h-3.5 w-3.5", yoloMode ? "text-rose-300" : "text-zinc-400"].join(" ")} />
                  Full access
                </button>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
              {attachments}
              {showContextBadge ? (
                <ContextWindowBadge
                  modelIds={selectedContextModelIds}
                  prompt={prompt}
                  historyText={contextHistoryText}
                  attachmentFiles={contextAttachmentFiles}
                  isRun={!isChat}
                />
              ) : null}
              {isRunActive ? (
                <Button variant="danger" size="sm" className="h-8 rounded-full px-3 text-xs" onClick={onCancel}>
                  Cancel run
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-8 shrink-0 rounded-full px-3 text-xs"
                disabled={isSubmitDisabled}
                onClick={() => void onSubmit()}
              >
                {submitLabel}
                {submitIcon}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
