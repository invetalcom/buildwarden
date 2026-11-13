export interface ForgeIssueAutomationInput {
  /** Open issues that carry the trigger label right now, newest first. */
  labelled: readonly number[];
  /** False when the host had more labelled issues than one check reads. */
  complete: boolean;
  /** Issues with a run that still exists, started by the trigger or by hand. */
  withRun: ReadonlySet<number>;
  /** Issues the trigger dealt with at earlier checks. */
  handled: readonly number[];
}

export interface ForgeIssueAutomationPlan {
  /** Issues to remember as dealt with, before any run of this check has started. */
  handled: number[];
  /** Issues to start a run for, in order. */
  pending: number[];
}

/**
 * Decides which labelled issues get a run. An issue is handled once per labelling: it stays handled when its
 * run is deleted or its link ages out of the link list, and becomes eligible again only after it lost the label
 * (or was closed) and got it back.
 */
export const planForgeIssueAutomation = (input: ForgeIssueAutomationInput): ForgeIssueAutomationPlan => {
  const labelled = new Set(input.labelled);
  // With an incomplete list, an issue missing from it may still carry the label, so nothing is forgotten.
  const handled = new Set(input.handled.filter((issueNumber) => !input.complete || labelled.has(issueNumber)));
  for (const issueNumber of input.labelled) {
    if (input.withRun.has(issueNumber)) handled.add(issueNumber);
  }
  return { handled: [...handled], pending: input.labelled.filter((issueNumber) => !handled.has(issueNumber)) };
};
