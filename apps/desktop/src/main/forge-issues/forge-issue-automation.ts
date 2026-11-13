export interface ForgeIssueAutomationInput {
  /** Open issues with the trigger label that this check read, newest first. */
  labelled: readonly number[];
  /**
   * Every issue that still carries the label, when this check finished reading the whole list.
   * Null while a long list is read over several checks, or when the reading may have skipped issues.
   */
  allLabelled: readonly number[] | null;
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
  // Without the whole list, an issue missing from this check may still carry the label, so nothing is forgotten.
  const stillLabelled = input.allLabelled ? new Set(input.allLabelled) : null;
  const handled = new Set(input.handled.filter((issueNumber) => !stillLabelled || stillLabelled.has(issueNumber)));
  for (const issueNumber of input.labelled) {
    if (input.withRun.has(issueNumber)) handled.add(issueNumber);
  }
  return { handled: [...handled], pending: input.labelled.filter((issueNumber) => !handled.has(issueNumber)) };
};
