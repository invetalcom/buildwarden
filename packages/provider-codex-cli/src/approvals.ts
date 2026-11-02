import type { RunUserInputAnswers, RunUserInputRequest } from "@buildwarden/shared";

type RequestUserInput = (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;

// Use the existing run/chat question bridge, but require an exact, explicit choice.
// Never turn file or network permission grants into cached shell allowlist entries.
export async function requestCodexApproval(
  requestUserInput: RequestUserInput | undefined,
  request: { id: string | number; method: string; params?: unknown },
  title: string,
  turnScope = false,
): Promise<boolean> {
  if (!requestUserInput) return false;
  const allowLabel = turnScope ? "Allow for this turn" : "Allow once";
  const scope = turnScope
    ? "Grant only the requested permissions until the current turn ends?"
    : "Approve this request once?";
  // Include the complete requested scope in the question: the question card hides
  // separate content when structured choices are present.
  const question = `${scope} Request details: ${JSON.stringify(request.params ?? {})}`;
  try {
    const answers = await requestUserInput({
      title,
      questions: [{
        id: "approval",
        header: "Approval",
        question,
        options: [{ label: "Deny" }, { label: allowLabel }],
        multiSelect: false,
        allowCustomAnswer: false,
      }],
      metadata: {
        provider: "codex-cli",
        requestKind: "approval",
        rawRequestId: request.id,
        rawRequestMethod: request.method,
        rawRequestParams: request.params ?? {},
      },
    });
    const answer = answers.approval;
    return answer === allowLabel || (Array.isArray(answer) && answer.length === 1 && answer[0] === allowLabel);
  } catch {
    // Cancellation, disconnection and UI failures must never grant access.
    return false;
  }
}
