export interface ForgeIssueAutomationInput {
  /** Open issues with the trigger label that this check read, newest first. */
  labelled: readonly number[];
  /**
   * Set when this check finished reading the whole list: every issue that still carries the label, and the
   * ISO time at which that reading began. Null while a long list is read over several checks, or when the
   * reading may have skipped issues.
   */
  pass: { labelled: readonly number[]; startedAt: string } | null;
  /**
   * Handled issues missing from `pass` that were read on their own and found closed or without the label.
   * Reading a long list page by page can miss an issue, so a missing issue alone is not forgotten.
   */
  confirmedUnlabelled: readonly number[];
  /** Runs that still exist and were started for an issue, by the trigger or by hand, with their ISO start time. */
  runs: readonly { issueNumber: number; createdAt: string }[];
  /** Issues the trigger dealt with at earlier checks. */
  handled: readonly number[];
  /** When the last complete reading before this check began, or null when there was none yet. */
  listReadAt: string | null;
}

export interface ForgeIssueAutomationPlan {
  /** Issues to remember as dealt with, before any run of this check has started. */
  handled: number[];
  /** The reading time to remember. */
  listReadAt: string | null;
  /** Issues to start a run for, in order. */
  pending: number[];
}

/**
 * Decides which labelled issues get a run. An issue is handled once per labelling: it stays handled when its
 * run is deleted or its link ages out of the link list, and becomes eligible again after it lost the label
 * (or was closed) and got it back.
 *
 * A run that still exists stands for the labelling it was started in, whoever started it. An issue that is
 * labelled but not handled did not carry the label at the last complete reading. A run from before that
 * reading therefore belongs to an earlier labelling and does not hold a new one back, while a run started
 * since then does. Without any complete reading so far, every run counts.
 */
/** Handled issues that a complete reading did not contain. They need a confirmation before they are forgotten. */
export const handledMissingFromPass = (handled: readonly number[], pass: { labelled: readonly number[] } | null): number[] => {
  if (!pass) return [];
  const listed = new Set(pass.labelled);
  return handled.filter((issueNumber) => !listed.has(issueNumber));
};

export const planForgeIssueAutomation = (input: ForgeIssueAutomationInput): ForgeIssueAutomationPlan => {
  // Forgotten are only issues that the whole list did not contain and that were confirmed one by one.
  const listed = input.pass ? new Set(input.pass.labelled) : null;
  const confirmed = new Set(input.confirmedUnlabelled);
  const handled = new Set(input.handled.filter((issueNumber) => !listed || listed.has(issueNumber) || !confirmed.has(issueNumber)));
  const { listReadAt } = input;
  const withRun = new Set(
    // A run without a readable start time counts: starting a second run is the costlier mistake.
    input.runs.filter((run) => !listReadAt || !run.createdAt || run.createdAt >= listReadAt).map((run) => run.issueNumber),
  );
  for (const issueNumber of input.labelled) {
    if (withRun.has(issueNumber)) handled.add(issueNumber);
  }
  return {
    handled: [...handled],
    listReadAt: input.pass?.startedAt ?? listReadAt,
    pending: input.labelled.filter((issueNumber) => !handled.has(issueNumber)),
  };
};
