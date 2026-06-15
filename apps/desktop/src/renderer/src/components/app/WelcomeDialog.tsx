import { useEffect, useRef, type ComponentType } from "react";
import { Check, Circle, Cpu, FolderOpen, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import {
  ProviderModelsSettingsTab,
  type ProviderModelsOpenPanel,
  type ProviderModelsSettingsTabProps,
} from "./settings-provider-models-tab";
import { ProjectSetupFields, type ProjectSetupFieldsProps } from "./settings-git-workspace-tab";
import { WELCOME_CHECK_DEFINITIONS, type WelcomeCheckId } from "./welcome-checks";
import { cn } from "../../lib/cn";

export type WelcomeStepKey = "intro" | "done" | WelcomeCheckId;

export type WelcomeDialogProps = {
  stepKey: WelcomeStepKey;
  stepIndex: number;
  steps: readonly WelcomeStepKey[];
  completedCheckIds: readonly WelcomeCheckId[];
  skippedCheckIds: readonly WelcomeCheckId[];
  providerModelsProps: ProviderModelsSettingsTabProps;
  providerModelsOpenPanel: ProviderModelsOpenPanel;
  projectSetupProps: ProjectSetupFieldsProps;
  onProviderModelsOpenPanelChange: (panel: ProviderModelsOpenPanel) => void;
  onBack: () => void;
  onIntroNext: () => void;
  onSkipCheck: (checkId: WelcomeCheckId) => void;
  onFinish: () => void;
};

const checkIconById: Record<WelcomeCheckId, ComponentType<{ className?: string }>> = {
  "provider-models": Cpu,
  project: FolderOpen,
};

const getStepLabel = (step: WelcomeStepKey): string => {
  if (step === "intro") return "Welcome";
  if (step === "done") return "Done";
  return WELCOME_CHECK_DEFINITIONS.find((check) => check.id === step)?.navLabel ?? step;
};

const formatCheckList = (checks: Array<{ navLabel: string }>): string => {
  if (checks.length === 0) return "";
  if (checks.length === 1) return checks[0]!.navLabel;
  return `${checks.slice(0, -1).map((check) => check.navLabel).join(", ")} and ${checks.at(-1)!.navLabel}`;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.hasAttribute("disabled")) return false;
    return element.offsetParent !== null || element === document.activeElement;
  });

export const WelcomeDialog = ({
  stepKey,
  stepIndex,
  steps,
  completedCheckIds,
  skippedCheckIds,
  providerModelsProps,
  providerModelsOpenPanel,
  projectSetupProps,
  onProviderModelsOpenPanelChange,
  onBack,
  onIntroNext,
  onSkipCheck,
  onFinish,
}: WelcomeDialogProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const completedSet = new Set(completedCheckIds);
  const skippedSet = new Set(skippedCheckIds);
  const allChecksComplete = WELCOME_CHECK_DEFINITIONS.every((check) => completedSet.has(check.id));
  const completedChecks = WELCOME_CHECK_DEFINITIONS.filter((check) => completedSet.has(check.id));
  const missingChecks = WELCOME_CHECK_DEFINITIONS.filter((check) => !completedSet.has(check.id));
  const skippedIncompleteChecks = WELCOME_CHECK_DEFINITIONS.filter((check) => skippedSet.has(check.id) && !completedSet.has(check.id));
  const currentCheck = stepKey !== "intro" && stepKey !== "done"
    ? WELCOME_CHECK_DEFINITIONS.find((check) => check.id === stepKey) ?? null
    : null;
  const missingCheckList = formatCheckList(missingChecks);
  const completedCheckList = formatCheckList(completedChecks);
  const introTitle =
    missingChecks.length === WELCOME_CHECK_DEFINITIONS.length
      ? "Tiny setup, then the fun part."
      : missingChecks.length === 1
        ? "Nice, just one thing left."
        : "Nice, a few bits are already ready.";
  const introDescription =
    missingChecks.length === WELCOME_CHECK_DEFINITIONS.length
      ? "Connect a model, pick a project folder, and BuildWarden can get out of checklist mode."
      : missingChecks.length > 0
        ? `Already done: ${completedCheckList}. Still needed: ${missingCheckList}.`
        : "Everything is already wired up. BuildWarden is ready when you are.";
  const introSubtitle =
    missingChecks.length === WELCOME_CHECK_DEFINITIONS.length
      ? "Two quick choices and you are ready for your first run."
      : missingChecks.length > 0
        ? `You already handled ${completedCheckList}. Let's finish ${missingCheckList}.`
        : "Everything looks ready. No extra homework today.";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();

    const focusWithinDialog = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) {
        return;
      }
      (getFocusableElements(dialog)[0] ?? titleRef.current ?? dialog).focus();
    };

    const trapTabKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        (titleRef.current ?? dialog).focus();
        return;
      }

      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeIndex = activeElement ? focusableElements.indexOf(activeElement) : -1;
      const firstElement = focusableElements[0]!;
      const lastElement = focusableElements[focusableElements.length - 1]!;

      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        lastElement.focus();
        return;
      }
      if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusableElements.length - 1)) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("focusin", focusWithinDialog);
    dialog.addEventListener("keydown", trapTabKey);
    return () => {
      document.removeEventListener("focusin", focusWithinDialog);
      dialog.removeEventListener("keydown", trapTabKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-zinc-950/70 p-4 backdrop-blur-md">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-dialog-title"
        tabIndex={-1}
        className="glass-popover flex max-h-[calc(100vh-2rem)] w-full max-w-6xl overflow-hidden text-[var(--ec-text)]"
      >
        <aside className="hidden w-60 shrink-0 border-r border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3 md:block">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ring-1 ring-[var(--ec-accent-ring)]">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold text-[var(--ec-text)]">BuildWarden</p>
              <p className="text-xs text-[var(--ec-muted)]">Quick start</p>
            </div>
          </div>
          <div className="mt-5 space-y-1">
            {steps.map((step, index) => {
              const active = step === stepKey;
              const check = step !== "intro" && step !== "done"
                ? WELCOME_CHECK_DEFINITIONS.find((entry) => entry.id === step)
                : null;
              const complete = check ? completedSet.has(check.id) : index < stepIndex;
              return (
                <div
                  key={step}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-2 text-sm",
                    active ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]" : "text-[var(--ec-muted)]",
                  )}
                >
                  {complete ? (
                    <Check className="h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
                  ) : (
                    <Circle className={cn("h-4 w-4 shrink-0", active ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]")} aria-hidden />
                  )}
                  <span className="min-w-0 truncate">{getStepLabel(step)}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-5 text-xs leading-5 text-[var(--ec-muted)]">
            You can skip individual setup steps. BuildWarden will bring this back on startup until every check has been completed once.
          </p>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-accent)]">
              Step {String(Math.min(stepIndex + 1, steps.length))} of {String(steps.length)}
            </p>
            <h2
              ref={titleRef}
              id="welcome-dialog-title"
              tabIndex={-1}
              className="mt-0.5 text-xl font-semibold tracking-tight text-[var(--ec-text)] outline-none"
            >
              {stepKey === "intro" ? "Welcome to BuildWarden" : stepKey === "done" ? (allChecksComplete ? "All set & done" : "Done for now") : currentCheck?.title}
            </h2>
            <p className="mt-0.5 max-w-3xl text-sm leading-5 text-[var(--ec-muted)]">
              {stepKey === "intro"
                ? introSubtitle
                : stepKey === "done"
                  ? allChecksComplete
                    ? "Provider, model, and project have all existed once. This hello screen will stop popping by."
                    : "You skipped the remaining bits. No drama; BuildWarden will ask again on a later startup."
                  : currentCheck?.description}
            </p>
          </header>

          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            {stepKey === "intro" ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
                  <p className="text-base font-semibold text-[var(--ec-text)]">{introTitle}</p>
                  <p className="mt-1 text-sm leading-5 text-[var(--ec-muted)]">
                    {introDescription}
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {WELCOME_CHECK_DEFINITIONS.map((check) => {
                    const Icon = checkIconById[check.id];
                    const complete = completedSet.has(check.id);
                    return (
                      <div key={check.id} className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--ec-control)] text-[var(--ec-accent)]">
                            <Icon className="h-4 w-4" aria-hidden />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[var(--ec-text)]">{check.navLabel}</p>
                            <p className="mt-1 text-xs leading-5 text-[var(--ec-muted)]">
                              {complete ? check.satisfiedLabel : check.description}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {stepKey === "provider-models" ? (
              <ProviderModelsSettingsTab
                {...providerModelsProps}
                presentation="welcome"
                openPanel={providerModelsOpenPanel}
                onOpenPanelChange={onProviderModelsOpenPanelChange}
              />
            ) : null}

            {stepKey === "project" ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
                  <ProjectSetupFields {...projectSetupProps} />
                </div>
                <p className="text-xs leading-5 text-[var(--ec-muted)]">
                  Git repositories unlock branch, worktree, commit, and PR/MR tools. Plain folders are supported too.
                </p>
              </div>
            ) : null}

            {stepKey === "done" ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-4">
                  <p className="text-base font-semibold text-[var(--ec-text)]">
                    {allChecksComplete ? "You're good to go." : "You're free to roam."}
                  </p>
                  <p className="mt-1 text-sm leading-5 text-[var(--ec-muted)]">
                    {allChecksComplete
                      ? "The setup checks have all been completed at least once, so future startup goes straight to the workspace."
                      : "Skipped steps are not marked done. The welcome screen will come back later until those bits are finished once."}
                  </p>
                </div>
                {skippedIncompleteChecks.length > 0 ? (
                  <div className="rounded-lg border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] p-3 text-sm text-[var(--ec-warning)]">
                    Still pending: {skippedIncompleteChecks.map((check) => check.navLabel).join(", ")}.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-4 py-3">
            <div className="flex items-center gap-1 md:hidden">
              {steps.map((step) => (
                <span
                  key={step}
                  className={cn("h-1.5 w-5 rounded-full", step === stepKey ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-border-strong)]")}
                />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {stepIndex > 0 ? (
                <Button type="button" variant="secondary" onClick={onBack}>
                  Back
                </Button>
              ) : null}
              {stepKey === "intro" ? (
                <Button type="button" onClick={onIntroNext}>
                  Get started
                </Button>
              ) : currentCheck ? (
                <Button type="button" onClick={() => onSkipCheck(currentCheck.id)}>
                  Skip this step
                </Button>
              ) : (
                <Button type="button" onClick={onFinish}>
                  Finish
                </Button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
};
