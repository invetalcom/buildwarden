import type { RunRecord, RunStepRecord } from "@buildwarden/shared";

export const RUN_FAILURE_STEP_ID_PREFIX = "run-failure:";

/**
 * Some paths mark a run failed and store the reason only on the run, without an error step.
 * Returns the steps with that reason added as a closing error step, so a failed run always says
 * why. Nothing changes when the run did not fail, has no reason, or an error step already says it.
 */
export const withRunFailureStep = (
  run: Pick<RunRecord, "id" | "status" | "errorMessage" | "finishedAt" | "updatedAt">,
  steps: RunStepRecord[],
): RunStepRecord[] => {
  const message = run.errorMessage?.trim();
  if (run.status !== "failed" || !message) return steps;
  // Only a step that carries the whole reason counts: "exited with code 1" must not hide "exited with code 127".
  // A status or error step written when the run failed closes the turn and explains it in its own
  // words, such as "Verification gate failed" or "Autonomy budget exhausted".
  const alreadyShown = steps.some((step) =>
    (step.eventType === "error" && step.content.includes(message))
    || (run.finishedAt !== null && (step.eventType === "error" || step.eventType === "status") && step.createdAt >= run.finishedAt));
  if (alreadyShown) return steps;
  return [
    ...steps,
    {
      id: `${RUN_FAILURE_STEP_ID_PREFIX}${run.id}`,
      runId: run.id,
      eventType: "error",
      title: "Run failed",
      content: message,
      metadataJson: "{}",
      createdAt: run.finishedAt ?? run.updatedAt,
    },
  ];
};
