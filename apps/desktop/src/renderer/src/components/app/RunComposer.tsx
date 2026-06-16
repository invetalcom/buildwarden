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
import {
  parseLeadingComposerCommand,
  type ComposerCommandDescriptor,
  type ComposerCommandContext,
  type RunMode,
  type RunWorkspaceType,
  type UnifiedProviderFamily,
  type ProviderType,
} from "@buildwarden/shared";
import { ArrowUp, Bot, BrainCircuit, Check, ChevronDown, GitBranch, ShieldOff, SlidersHorizontal, WandSparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ContextWindowBadge } from "./ContextWindowBadge";

const RUN_MODES: RunMode[] = ["code", "plan", "ask"];
const MAX_VISIBLE_COMPOSER_COMMANDS = 5;
const MAX_COMPOSER_COMMAND_SECONDARY_CHARS = 60;

const truncateComposerCommandText = (value: string, maxChars = MAX_COMPOSER_COMMAND_SECONDARY_CHARS): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
};

const getComposerCommandSecondaryText = (command: ComposerCommandDescriptor): string =>
  truncateComposerCommandText([command.argumentHint, command.description].filter(Boolean).join(" "));

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
  selectedIconClassName = "text-[var(--ec-accent)]",
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
        className={`inline-flex h-9 items-center gap-2 rounded-full border border-transparent bg-transparent px-3 text-sm text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] disabled:pointer-events-none disabled:opacity-50 ${buttonClassName}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || options.length === 0}
      >
        <Icon className={`h-4 w-4 ${iconClassName}`} />
        <span className="max-w-[16rem] truncate text-[var(--ec-text)]">{selectedOption?.displayLabel ?? selectedOption?.label ?? "Select"}</span>
        <ChevronDown className={`h-4 w-4 text-[var(--ec-faint)] transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`glass-popover app-scrollbar absolute left-0 z-[90] max-h-72 min-w-full overflow-auto p-1.5 ${
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
                  isSelected
                    ? "bg-[var(--ec-control)] text-[var(--ec-text)]"
                    : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
  selectedIconClassName = "text-[var(--ec-accent)]",
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
        className={`inline-flex h-9 items-center gap-2 rounded-full border border-transparent bg-transparent px-3 text-sm text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] disabled:pointer-events-none disabled:opacity-50 ${buttonClassName}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || options.length === 0}
      >
        <Icon className={`h-4 w-4 ${iconClassName}`} />
        <span className="max-w-[16rem] truncate text-[var(--ec-text)]">{summaryLabel}</span>
        <ChevronDown className={`h-4 w-4 text-[var(--ec-faint)] transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`glass-popover app-scrollbar absolute left-0 z-[90] max-h-72 min-w-full overflow-auto p-1.5 ${
            menuSide === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
          } ${menuClassName}`}
        >
          <p className="px-2 pb-1 text-[11px] uppercase tracking-wide text-[var(--ec-faint)]">Select one or more</p>
          {options.map((option) => {
            const isSelected = selectedSet.has(option.value);

            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                  isSelected
                    ? "bg-[var(--ec-control)] text-[var(--ec-text)]"
                    : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
  copy: "Copy",
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
  workspaceTypeOptions,
  workspaceLabels,
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
  workspaceTypeOptions?: RunWorkspaceType[];
  workspaceLabels?: Partial<Record<RunWorkspaceType, string>>;
  disabled?: boolean;
  menuSide: "top" | "bottom";
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const workspaceLabel = selectedWorkspaceType ? (workspaceLabels?.[selectedWorkspaceType] ?? WORKSPACE_LABELS[selectedWorkspaceType]) : null;
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
  const workspaceOptions = (workspaceTypeOptions ?? ["worktree", "local"]).map((value) => ({
    value,
    label: workspaceLabels?.[value] ?? WORKSPACE_LABELS[value],
  }));

  return (
    <div ref={rootRef} className={`relative ${open ? "z-[80]" : "z-10"}`}>
      <button
        type="button"
        className="inline-flex h-9 max-w-[22rem] items-center gap-2 rounded-full border border-transparent bg-transparent px-3 text-sm text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] disabled:pointer-events-none disabled:opacity-50"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <SlidersHorizontal className="h-4 w-4 text-[var(--ec-muted)]" />
        <span className="truncate text-[var(--ec-text)]">{summary || "Run settings"}</span>
        <ChevronDown className={`h-4 w-4 text-[var(--ec-faint)] transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className={`glass-popover app-scrollbar absolute left-0 z-[90] w-72 max-h-80 overflow-auto p-2 ${
            menuSide === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
          }`}
        >
          <div className="space-y-2">
            <div>
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">Mode</p>
              <div className="grid grid-cols-3 gap-1">
                {modeOptions.map((option) => {
                  const selected = option.value === selectedMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-lg px-2 py-1.5 text-xs transition ${
                        selected
                          ? "bg-[var(--ec-control)] text-[var(--ec-text)]"
                          : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">Workspace</p>
                <div className="grid grid-cols-2 gap-1">
                  {workspaceOptions.map((option) => {
                    const selected = option.value === selectedWorkspaceType;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`rounded-lg px-2 py-1.5 text-xs transition ${
                          selected
                            ? "bg-[var(--ec-control)] text-[var(--ec-text)]"
                            : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">Branch</p>
                <div className="max-h-36 overflow-auto pr-0.5">
                  {branchOptions.map((option) => {
                    const selected = option.value === selectedBranch;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                          selected
                            ? "bg-[var(--ec-control)] text-[var(--ec-text)]"
                            : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                        } ${branchDisabled ? "pointer-events-none opacity-60" : ""}`}
                        onClick={() => {
                          onBranchChange(option.value);
                          setOpen(false);
                        }}
                        disabled={branchDisabled}
                      >
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--ec-faint)]" />
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
  commandContext?: ComposerCommandContext;
  projectId?: string;
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
  workspaceTypeOptions?: RunWorkspaceType[];
  workspaceLabels?: Partial<Record<RunWorkspaceType, string>>;
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
  /** When set, pasting files into the prompt (e.g. copied from Explorer/Finder) adds them like Attach; parent should merge with `appendChatAttachmentFiles` from `@buildwarden/shared`. */
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
  commandContext = "run",
  projectId,
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
  workspaceTypeOptions,
  workspaceLabels,
  busy,
  isRunActive = false,
  onCancel,
  onSubmit,
  submitLabel = "Send",
  submitIcon = <ArrowUp className="h-5 w-5" />,
  placeholder = "Ask BuildWarden to continue this run, refine the diff, fix a bug, or explain a change.",
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
  const effectiveCommandContext: ComposerCommandContext = isChat ? "chat" : commandContext;
  const leadingComposerCommand = useMemo(() => parseLeadingComposerCommand(prompt), [prompt]);
  const slashCommandQuery = useMemo(() => {
    const trimmedStart = prompt.trimStart();
    if (!trimmedStart.startsWith("/")) {
      return null;
    }
    const token = trimmedStart.split(/\s/, 1)[0] ?? "/";
    return token.toLowerCase();
  }, [prompt]);
  const commandModelId = useMemo(() => {
    if (useMultiModel) {
      return activeModelOption?.value ?? "";
    }
    return selectedModelId;
  }, [activeModelOption?.value, selectedModelId, useMultiModel]);
  const [availableComposerCommands, setAvailableComposerCommands] = useState<ComposerCommandDescriptor[]>([]);
  const [composerCommandsLoading, setComposerCommandsLoading] = useState(false);
  const [showAllComposerCommands, setShowAllComposerCommands] = useState(false);
  const composerCommandRequestRef = useRef(0);
  const composerCommandCacheRef = useRef(new Map<string, ComposerCommandDescriptor[]>());
  const canLoadComposerCommands =
    Boolean(slashCommandQuery) && !busy && !isRunActive && Boolean(commandModelId) && effectiveCommandContext !== "chat";

  useEffect(() => {
    setShowAllComposerCommands(false);
  }, [commandModelId, effectiveCommandContext, slashCommandQuery]);

  useEffect(() => {
    if (!canLoadComposerCommands || !slashCommandQuery) {
      composerCommandRequestRef.current += 1;
      setAvailableComposerCommands([]);
      setComposerCommandsLoading(false);
      return;
    }

    const cacheKey = [commandModelId, projectId ?? "", effectiveCommandContext, slashCommandQuery].join("|");
    const cached = composerCommandCacheRef.current.get(cacheKey);
    if (cached) {
      setAvailableComposerCommands(cached);
      setComposerCommandsLoading(false);
      return;
    }

    const requestId = composerCommandRequestRef.current + 1;
    composerCommandRequestRef.current = requestId;
    setComposerCommandsLoading(true);

    const timerId = window.setTimeout(() => {
      void window.buildwarden
        .listComposerCommands({
          modelId: commandModelId,
          projectId,
          context: effectiveCommandContext,
          query: slashCommandQuery,
        })
        .then((commands) => {
          composerCommandCacheRef.current.set(cacheKey, commands);
          if (composerCommandRequestRef.current === requestId) {
            setAvailableComposerCommands(commands);
          }
        })
        .catch(() => {
          if (composerCommandRequestRef.current === requestId) {
            setAvailableComposerCommands([]);
          }
        })
        .finally(() => {
          if (composerCommandRequestRef.current === requestId) {
            setComposerCommandsLoading(false);
          }
        });
    }, 80);

    return () => window.clearTimeout(timerId);
  }, [canLoadComposerCommands, commandModelId, effectiveCommandContext, projectId, slashCommandQuery]);

  const visibleComposerCommands = canLoadComposerCommands
    ? showAllComposerCommands
      ? availableComposerCommands
      : availableComposerCommands.slice(0, MAX_VISIBLE_COMPOSER_COMMANDS)
    : [];
  const hasMoreComposerCommands =
    canLoadComposerCommands && !showAllComposerCommands && availableComposerCommands.length > MAX_VISIBLE_COMPOSER_COMMANDS;
  const hasSupportedLeadingCommand = Boolean(
    leadingComposerCommand && availableComposerCommands.some((command) => command.command === leadingComposerCommand.command),
  );
  const showUnsupportedSlashCommand =
    Boolean(slashCommandQuery && slashCommandQuery.length > 1) &&
    visibleComposerCommands.length === 0 &&
    !hasSupportedLeadingCommand &&
    prompt.trimStart().startsWith("/") &&
    !busy &&
    !isRunActive &&
    !composerCommandsLoading;
  const selectComposerCommand = (command: ComposerCommandDescriptor) => {
    const parsed = parseLeadingComposerCommand(prompt);
    if (command.effect === "set-run-mode") {
      if (command.runMode) {
        onModeChange(command.runMode);
      }
      onPromptChange(parsed?.argument ?? "");
      textareaRef.current?.focus();
      return;
    }

    const argument = parsed?.argument ?? "";
    onPromptChange(`${command.command}${argument ? ` ${argument}` : " "}`);
    setShowAllComposerCommands(false);
    textareaRef.current?.focus();
  };
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

  const textareaMinClass = isChat ? (dense ? "min-h-28 sm:min-h-32" : "min-h-36 sm:min-h-44") : dense ? "min-h-24" : "min-h-32";

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
        <div className="app-input-surface rounded-[1.75rem] border border-[var(--ec-border)] bg-[var(--ec-input)] shadow-[0_18px_50px_rgba(0,0,0,0.18)] transition focus-within:border-[var(--ec-accent)] focus-within:shadow-[var(--ec-action-shadow)]">
          <Textarea
            ref={textareaRef}
            className={`${textareaMinClass} !border-0 !bg-transparent resize-none rounded-[1.75rem] px-5 pb-2 pt-4 text-[15px] leading-relaxed placeholder:text-[15px] placeholder:font-normal focus:!border-transparent focus:!ring-0 sm:placeholder:text-[15px] ${textareaClassName}`.trim()}
            placeholder={placeholder}
            value={prompt}
            autoFocus={autoFocus}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            onPaste={handlePromptPaste}
            disabled={busy || isRunActive}
          />
          {visibleComposerCommands.length > 0 ? (
            <div className="mx-2 mb-1 flex flex-wrap gap-1 border-t border-[var(--ec-border)] px-1 pt-1.5">
              {visibleComposerCommands.map((command) => {
                const secondaryText = getComposerCommandSecondaryText(command);
                return (
                  <button
                    key={command.id}
                    type="button"
                    className="inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border border-[var(--ec-border)] bg-[var(--ec-control)] px-2 py-1 text-left text-xs text-[var(--ec-text)] transition hover:border-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
                    onClick={() => selectComposerCommand(command)}
                    title={[command.argumentHint, command.description].filter(Boolean).join(" ")}
                  >
                    <WandSparkles className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" />
                    <span className="shrink-0 font-mono">{command.command}</span>
                    {secondaryText ? <span className="min-w-0 truncate text-[var(--ec-muted)]">{secondaryText}</span> : null}
                  </button>
                );
              })}
              {hasMoreComposerCommands ? (
                <button
                  type="button"
                  className="inline-flex items-center rounded-lg border border-[var(--ec-border)] bg-[var(--ec-control)] px-2 py-1 text-xs text-[var(--ec-muted)] transition hover:border-[var(--ec-accent)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                  onClick={() => {
                    setShowAllComposerCommands(true);
                    textareaRef.current?.focus();
                  }}
                  title="Show all slash commands"
                >
                  ...
                </button>
              ) : null}
            </div>
          ) : showUnsupportedSlashCommand ? (
            <div className="mx-2 mb-1 border-t border-[var(--ec-border)] px-1 pt-1.5 text-[11px] text-[var(--ec-danger)]">
              Slash command is not available for the selected model provider.
            </div>
          ) : null}
          <div className="flex flex-col gap-2 px-3 pb-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {attachments}
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
                  workspaceTypeOptions={workspaceTypeOptions}
                  workspaceLabels={workspaceLabels}
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
                      ? "Full access on: BuildWarden will not ask before tools or shell commands."
                      : "Full access off: BuildWarden will ask before untrusted tools or shell commands."
                  }
                  disabled={busy}
                  onClick={() => onYoloModeChange(!yoloMode)}
                  className={[
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-transparent bg-transparent px-3 text-sm font-medium transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)]",
                    yoloMode ? "text-[var(--ec-danger)]" : "text-[var(--ec-muted)] hover:text-[var(--ec-text)]",
                    busy ? "cursor-not-allowed opacity-60" : "",
                  ].join(" ")}
                >
                  <ShieldOff className={["h-4 w-4", yoloMode ? "text-[var(--ec-danger)]" : "text-[var(--ec-muted)]"].join(" ")} />
                  Full access
                </button>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {useMultiModel ? (
                <ComposerMultiModelSelect
                  selectedIds={selectedModelIds}
                  icon={Bot}
                  iconClassName="text-[var(--ec-muted)]"
                  options={modelSelectOptions}
                  onChange={multiModelChange}
                  disabled={busy}
                  menuClassName="w-[22rem]"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-[var(--ec-accent)]"
                />
              ) : (
                <ComposerSelect
                  value={selectedModelId}
                  icon={Bot}
                  iconClassName="text-[var(--ec-muted)]"
                  options={modelSelectOptions}
                  onChange={onModelChange}
                  disabled={busy}
                  menuClassName="w-[22rem]"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-[var(--ec-accent)]"
                />
              )}
              {showReasoningControl && onReasoningEffortChange ? (
                <ComposerSelect
                  value={reasoningEffort || "medium"}
                  icon={BrainCircuit}
                  iconClassName="text-[var(--ec-muted)]"
                  options={reasoningSelectOptions}
                  onChange={onReasoningEffortChange}
                  disabled={busy}
                  menuClassName="w-52"
                  menuSide={dropdownSide}
                  selectedIconClassName="text-[var(--ec-accent)]"
                />
              ) : null}
              {showMultiReasoningControl ? (
                <ComposerSelect
                  value={normalizedMultiReasoning}
                  icon={BrainCircuit}
                  iconClassName="text-[var(--ec-muted)]"
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
                  selectedIconClassName="text-[var(--ec-accent)]"
                />
              ) : null}
              {showAnthropicControl && onAnthropicEffortChange ? (
                <ComposerSelect
                  value={anthropicEffort || "medium"}
                  icon={BrainCircuit}
                  iconClassName="text-[var(--ec-muted)]"
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
                  selectedIconClassName="text-[var(--ec-accent)]"
                />
              ) : null}
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
                <Button variant="danger" size="sm" className="h-9 rounded-full px-3 text-xs" onClick={onCancel}>
                  Cancel run
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-11 w-11 shrink-0 rounded-full p-0 text-sm shadow-[var(--ec-action-shadow)] [&_svg]:m-0 [&_svg]:h-5 [&_svg]:w-5"
                disabled={isSubmitDisabled}
                onClick={() => void onSubmit()}
                title={submitLabel}
                aria-label={submitLabel}
              >
                <span className="sr-only">{submitLabel}</span>
                {submitIcon}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
