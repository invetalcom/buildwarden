import { useMemo, useState } from "react";
import { Check, Loader2, MessageSquareText, Send } from "lucide-react";
import type { RunUserInputAnswers, RunUserInputQuestion } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentPanel } from "./agent-worklog";

type DraftAnswer = {
  selected: string[];
  custom: string;
};

type DraftAnswers = Record<string, DraftAnswer>;

const normalizeAnswerValues = (answer: string | string[] | undefined): string[] => {
  if (Array.isArray(answer)) {
    return answer.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof answer === "string" && answer.trim() ? [answer] : [];
};

const buildInitialDrafts = (questions: RunUserInputQuestion[], answers?: RunUserInputAnswers | null): DraftAnswers => {
  const drafts: DraftAnswers = {};
  for (const question of questions) {
    const values = normalizeAnswerValues(answers?.[question.id]);
    const optionLabels = new Set(question.options.map((option) => option.label));
    drafts[question.id] = {
      selected: values.filter((value) => optionLabels.has(value)),
      custom: values.find((value) => !optionLabels.has(value)) ?? "",
    };
  }
  return drafts;
};

const buildAnswers = (questions: RunUserInputQuestion[], drafts: DraftAnswers): RunUserInputAnswers | null => {
  const answers: RunUserInputAnswers = {};
  for (const question of questions) {
    const draft = drafts[question.id] ?? { selected: [], custom: "" };
    const custom = draft.custom.trim();
    if (custom) {
      answers[question.id] = custom;
      continue;
    }
    if (question.multiSelect) {
      if (draft.selected.length === 0) {
        return null;
      }
      answers[question.id] = draft.selected;
      continue;
    }
    const selected = draft.selected[0];
    if (!selected) {
      return null;
    }
    answers[question.id] = selected;
  }
  return answers;
};

const looksLikeJsonPayload = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

const getDisplayContent = (content: string, questions: RunUserInputQuestion[]) => {
  if (questions.length > 0) {
    return "";
  }
  const trimmed = content.trim();
  if (!trimmed || looksLikeJsonPayload(trimmed)) {
    return "";
  }
  const duplicateQuestion = questions.some((question) => question.question.trim() === trimmed);
  return duplicateQuestion ? "" : trimmed;
};

export function RunUserInputRequestCard({
  runId,
  requestId,
  title,
  content,
  timestamp,
  questions,
  answers,
  resolved,
  disabled,
  onSubmitAnswers,
}: Readonly<{
  runId: string;
  requestId: string;
  title: string;
  content: string;
  timestamp: string;
  questions: RunUserInputQuestion[];
  answers?: RunUserInputAnswers | null;
  resolved: boolean;
  disabled?: boolean;
  onSubmitAnswers?: (answers: RunUserInputAnswers) => Promise<void> | void;
}>) {
  const buildwarden = useBuildWardenClient();
  const [drafts, setDrafts] = useState<DraftAnswers>(() => buildInitialDrafts(questions, answers));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftAnswers = useMemo(() => buildAnswers(questions, drafts), [questions, drafts]);
  const displayContent = useMemo(() => getDisplayContent(content, questions), [content, questions]);
  const canSubmit = Boolean(draftAnswers) && !submitting && !resolved && !disabled;

  const toggleOption = (question: RunUserInputQuestion, label: string) => {
    if (resolved || submitting || disabled) {
      return;
    }
    setDrafts((current) => {
      const existing = current[question.id] ?? { selected: [], custom: "" };
      let selected = [label];
      if (question.multiSelect) {
        selected = existing.selected.includes(label)
          ? existing.selected.filter((entry) => entry !== label)
          : [...existing.selected, label];
      }
      return {
        ...current,
        [question.id]: {
          selected,
          custom: "",
        },
      };
    });
  };

  const updateCustom = (questionId: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [questionId]: {
        selected: value.trim() ? [] : current[questionId]?.selected ?? [],
        custom: value,
      },
    }));
  };

  const submit = async () => {
    const nextAnswers = buildAnswers(questions, drafts);
    if (!nextAnswers || submitting || resolved || disabled) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (onSubmitAnswers) {
        await onSubmitAnswers(nextAnswers);
      } else {
        await buildwarden.respondToRunUserInput(runId, requestId, nextAnswers);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit this answer.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AgentPanel tone="request" className="px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-info)]" />
          <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">{title}</p>
          <Badge
            tone={resolved ? "completed" : "queued"}
            className="px-1.5 py-0 text-[10px] bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)] ring-[color:var(--ec-info-ring)]"
          >
            {resolved ? "answered" : "question"}
          </Badge>
        </div>
        <span className="shrink-0 text-[10px] text-[color:var(--ec-faint)]">{timestamp}</span>
      </div>

      {displayContent ? (
        <p className="mt-1.5 rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-control)] px-2 py-1.5 text-[11px] leading-relaxed text-[color:var(--ec-muted)]">
          {displayContent}
        </p>
      ) : null}

      <div className="mt-2 space-y-2">
        {questions.map((question, index) => {
          const draft = drafts[question.id] ?? { selected: [], custom: "" };
          const answeredValues = normalizeAnswerValues(answers?.[question.id]);
          const showCustomInput = !resolved && (question.allowCustomAnswer === true || question.options.length === 0);
          return (
            <div key={`${question.id}:${index}`} className="rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-panel-muted)] p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-[color:var(--ec-control)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ec-faint)]">
                  {question.header}
                </span>
                {question.multiSelect ? <span className="text-[10px] text-[color:var(--ec-faint)]">multi-select</span> : null}
              </div>
              <p className="mt-1.5 text-xs font-medium leading-relaxed text-[color:var(--ec-text)]">{question.question}</p>
              {question.options.length > 0 ? (
                <div className="mt-2 grid gap-1.5">
                  {question.options.map((option) => {
                    const selected = resolved ? answeredValues.includes(option.label) : draft.selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={resolved || submitting || disabled}
                        onClick={() => toggleOption(question, option.label)}
                        className={cn(
                          "group flex w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition",
                          selected
                            ? "border-[color:var(--ec-info-ring)] bg-[color:var(--ec-info-soft)] text-[color:var(--ec-text)]"
                            : "border-[color:var(--ec-border)] bg-[color:var(--ec-control)] text-[color:var(--ec-muted)] hover:border-[color:var(--ec-border-strong)] hover:text-[color:var(--ec-text)]",
                          (resolved || submitting || disabled) && "cursor-default opacity-80",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                            selected
                              ? "border-[color:var(--ec-info)] bg-[color:var(--ec-info)] text-white"
                              : "border-[color:var(--ec-border-strong)] text-transparent group-hover:border-[color:var(--ec-muted)]",
                          )}
                        >
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-semibold text-[color:var(--ec-text)]">{option.label}</span>
                          {option.description ? (
                            <span className="mt-0.5 block text-[11px] leading-snug text-[color:var(--ec-muted)]">{option.description}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {showCustomInput ? (
                <textarea
                  value={draft.custom}
                  onChange={(event) => updateCustom(question.id, event.target.value)}
                  placeholder={question.options.length > 0 ? "Other answer" : "Type your answer"}
                  rows={2}
                  className="mt-2 w-full resize-y rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-input)] px-2 py-1.5 text-xs text-[color:var(--ec-text)] outline-none transition placeholder:text-[color:var(--ec-faint)] focus:border-[color:var(--ec-ring)]"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? <p className="mt-2 text-[11px] text-[color:var(--ec-danger)]">{error}</p> : null}
      {!resolved ? (
        <div className="mt-2 flex justify-end">
          <Button type="button" size="xs" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Submit answer
          </Button>
        </div>
      ) : null}
    </AgentPanel>
  );
}
