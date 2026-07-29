import { useMemo, useState } from "react";
import type { RunDetail, RunUserInputAnswers, RunUserInputQuestion } from "@buildwarden/shared";
import { readUserInputAnswers, readUserInputQuestions } from "@buildwarden/renderer/logic";
import { MessageCircleQuestion } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { cn } from "../../lib/cn";
import { Button, InlineError, Input } from "../../components/primitives";

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

interface PendingRequest {
  requestId: string;
  questions: RunUserInputQuestion[];
}

/** The newest unanswered `user-input-requested` step, if any. */
const findPendingUserInput = (detail: RunDetail): PendingRequest | null => {
  for (let index = detail.steps.length - 1; index >= 0; index -= 1) {
    const step = detail.steps[index];
    if (step.eventType !== "user-input-requested") continue;
    const metadata = parseMetadata(step.metadataJson);
    if (readUserInputAnswers(metadata)) return null;
    // Matches the desktop reader: newer steps use `userInputRequestId`, older ones `requestId`.
    const requestId = [metadata.userInputRequestId, metadata.requestId].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const questions = readUserInputQuestions(metadata);
    if (requestId && questions.length > 0) return { requestId, questions };
  }
  return null;
};

/**
 * Answering a blocking question is the single most valuable thing to do from a phone, so it is
 * pinned above the composer rather than living inside the scrolling timeline.
 */
export const RunUserInputCard = ({ detail, onAnswered }: { detail: RunDetail; onAnswered: () => Promise<void> }) => {
  const { client } = useMobileApp();
  const action = useAction();
  const request = useMemo(() => findPendingUserInput(detail), [detail]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  if (!request) return null;

  const answered = request.questions.every((question) => selections[question.id] || other[question.id]?.trim());

  const submit = async () => {
    const answers: RunUserInputAnswers = Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        other[question.id]?.trim() ? other[question.id].trim() : selections[question.id] ?? "",
      ]),
    );
    const result = await action.run(
      () => client.respondToRunUserInput(detail.run.id, request.requestId, answers),
      "The answer did not reach the host.",
    );
    if (result !== undefined) {
      setSelections({});
      setOther({});
      await onAnswered();
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-warning)]">
        <MessageCircleQuestion className="size-3.5" />
        The agent needs an answer
      </div>

      {action.error ? <InlineError message={action.error} /> : null}

      <div className="m-scroll-thin mt-2 flex max-h-64 flex-col gap-3 overflow-y-auto">
        {request.questions.map((question) => (
          <div key={question.id}>
            <p className="m-wrap-anywhere text-[13px] font-medium leading-5">{question.question}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const selected = selections[question.id] === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => {
                      setSelections((current) => ({ ...current, [question.id]: option.label }));
                      setOther((current) => ({ ...current, [question.id]: "" }));
                    }}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                      selected
                        ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                        : "border-[var(--ec-border)] text-[var(--ec-muted)]",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <Input
              value={other[question.id] ?? ""}
              onChange={(event) => {
                setOther((current) => ({ ...current, [question.id]: event.target.value }));
                setSelections((current) => ({ ...current, [question.id]: "" }));
              }}
              placeholder="Or type your own answer"
              className="mt-1.5 text-[13px]"
            />
          </div>
        ))}
      </div>

      <Button block className="mt-2.5" busy={action.busy} disabled={!answered} onClick={() => void submit()}>
        Send answer
      </Button>
    </div>
  );
};
