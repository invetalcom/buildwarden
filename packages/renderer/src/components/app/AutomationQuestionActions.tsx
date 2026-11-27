import { useState } from "react";
import type { AutomationQuestionAttention } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Answer buttons of an automation question in the attention inbox. */
export const AutomationQuestionActions = ({ question, client, disabled, onAnswered }: {
  question: AutomationQuestionAttention;
  client: BuildWardenClient;
  disabled: boolean;
  onAnswered: (error: string | null) => void | Promise<void>;
}) => {
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  if (!client.capabilities.approvalResponses) return null;
  const answer = async (choice: string) => {
    setSending(true);
    let failure: string | null = null;
    try {
      await client.answerAutomationQuestion({ workflowRunId: question.workflowRunId, stepId: question.stepId, choice, reason: reason.trim() || null });
    } catch (error) {
      failure = formatAppErrorMessage(error, "Could not send the answer.");
    } finally {
      setSending(false);
    }
    await onAnswered(failure);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {question.requireReason ? (
        <Input aria-label="Reason for the answer" className="h-7 min-w-36 flex-1 text-xs" value={reason} placeholder="Reason (required)"
          onChange={(event) => setReason(event.target.value)} />
      ) : null}
      {question.choices.map((choice, index) => (
        <Button key={choice} type="button" size="xs" variant={index === 0 ? "default" : "secondary"} className="h-7 px-2 text-[11px]"
          disabled={disabled || sending || (question.requireReason && !reason.trim())} onClick={() => void answer(choice)}>{choice}</Button>
      ))}
    </div>
  );
};
