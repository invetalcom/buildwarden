import { isCouncilRoundActive, type CouncilRound, type ProjectLoopRecord, type RunRecord, type RunVerificationState } from "@buildwarden/shared";

const COUNCIL_POLL_MS = 10_000;
/** A failing verification gets this many fix turns before the iteration fails. */
const LOOP_VERIFICATION_FIX_ATTEMPTS = 2;

/** What the checks before a loop's pull request need from the loop runner. */
export interface LoopPrCheckHost {
  /** The run's latest council round, with `stale` set when the workspace changed since it started. */
  latestCouncilRound(runId: string): Promise<CouncilRound | undefined>;
  getCouncilRound(roundId: string): CouncilRound;
  startCouncil(runId: string): Promise<CouncilRound>;
  applyCouncilFindings(roundId: string, groupIds: string[]): Promise<CouncilRound>;
  verifyRun(runId: string): Promise<RunVerificationState>;
  /** True when the run's current revision already passed verification. */
  verificationIsCurrent(runId: string): Promise<boolean>;
  /** Sends a fix turn to the iteration's run and resolves once it ended. */
  followUpAndWait(runId: string, prompt: string): Promise<RunRecord>;
  sleep(ms: number): Promise<void>;
  assertNotCancelled(): void;
  appendEvent(label: string, content: string): void;
}

const waitForRound = async (host: LoopPrCheckHost, roundId: string): Promise<CouncilRound> => {
  for (;;) {
    host.assertNotCancelled();
    const round = host.getCouncilRound(roundId);
    if (!isCouncilRoundActive(round)) return round;
    await host.sleep(COUNCIL_POLL_MS);
  }
};

/**
 * A round a resumed loop can keep instead of reviewing again: one still working, one whose findings were
 * applied (applying always changes what it reviewed), or a finished one whose subject is unchanged.
 */
const reusableRound = (round: CouncilRound | undefined): CouncilRound | undefined => {
  if (!round) return undefined;
  if (isCouncilRoundActive(round) || round.status === "applied") return round;
  return round.status === "ready" && !round.stale ? round : undefined;
};

/**
 * Council review of the iteration's changes. Recommended findings go back to the agent. A review that cannot
 * finish (no reviewers, usage limits) is reported and does not hold up the loop. True when it changed the code.
 */
const runCouncilCheck = async (host: LoopPrCheckHost, run: RunRecord): Promise<boolean> => {
  let round: CouncilRound;
  let resumedFinished = false;
  try {
    const reusable = reusableRound(await host.latestCouncilRound(run.id));
    resumedFinished = Boolean(reusable && !isCouncilRoundActive(reusable));
    round = reusable ?? await host.startCouncil(run.id);
  } catch (error) {
    host.appendEvent("Council review skipped", `The council review could not start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  round = await waitForRound(host, round.id);
  // A council that applies its findings on its own can fail to apply them; that must not open the PR either.
  if (round.status === "apply-failed") throw new Error(round.error?.trim() || "Fixing the council findings failed.");
  if (round.status !== "ready" && round.status !== "applied") {
    host.appendEvent("Council review skipped", round.error?.trim() || "The council review could not finish.");
    return false;
  }
  const recommended = round.groups.filter((group) => group.decision === "recommended" && !round.appliedGroupIds.includes(group.id));
  if (round.status === "ready" && recommended.length) {
    host.appendEvent("Council review", `Fixing ${String(recommended.length)} recommended finding${recommended.length === 1 ? "" : "s"}:\n${
      recommended.map((group) => `- [${group.severity}] ${group.title}`).join("\n")}`);
    await host.applyCouncilFindings(round.id, recommended.map((group) => group.id));
    round = await waitForRound(host, round.id);
    if (round.status === "apply-failed") throw new Error(round.error?.trim() || "Fixing the council findings failed.");
    host.appendEvent("Council findings fixed", `${String(round.appliedGroupIds.length)} findings were sent back to the agent and fixed.`);
    return true;
  }
  if (resumedFinished) return false;
  if (round.status === "applied") {
    host.appendEvent("Council findings fixed", `${String(round.appliedGroupIds.length)} findings were fixed by the council.`);
    return true;
  }
  host.appendEvent("Council review", round.groups.length
    ? `${String(round.groups.length)} findings, none recommended for fixing.`
    : "The reviewers found nothing to fix.");
  return false;
};

/**
 * Runs the project's verification commands and lets the agent fix failures a limited number of times.
 * A revision that already passed is not verified again. True when a fix turn changed the code.
 */
const runVerificationCheck = async (host: LoopPrCheckHost, run: RunRecord): Promise<boolean> => {
  if (await host.verificationIsCurrent(run.id)) return false;
  for (let attempt = 0; ; attempt += 1) {
    host.assertNotCancelled();
    const result = await host.verifyRun(run.id);
    // Cancelling the loop does not stop a verification, so a late failure must not start a fix turn.
    host.assertNotCancelled();
    if (result.status === "unconfigured") {
      host.appendEvent("Verification skipped", "The project has no verification commands. Add them in the project settings.");
      return false;
    }
    if (result.status === "passed") {
      host.appendEvent("Verification passed", result.commands.join("\n"));
      return attempt > 0;
    }
    const reason = result.reason?.trim() || `Verification ended as "${result.status}".`;
    if (result.status !== "failed" || attempt >= LOOP_VERIFICATION_FIX_ATTEMPTS) {
      throw new Error(`Verification did not pass${attempt ? ` after ${String(attempt)} fix attempts` : ""}: ${reason}`);
    }
    host.appendEvent("Verification failed", `${reason}\nThe agent is asked to fix it (attempt ${String(attempt + 1)} of ${String(LOOP_VERIFICATION_FIX_ATTEMPTS)}).`);
    const fixed = await host.followUpAndWait(run.id, [
      "The project's verification commands failed on your changes:",
      reason,
      `Commands: ${result.commands.join(" && ")}`,
      "Fix the cause, run the commands yourself until they pass, and keep the iteration objective intact.",
    ].join("\n"));
    if (fixed.status !== "completed") throw new Error(`The fix turn for the failing verification ended as "${fixed.status}".`);
  }
};

/**
 * The checks a loop runs on each iteration before the UI review, so the screenshots a person approves already
 * show their fixes. `changed` tells the loop that a fix turn changed the code since the screenshots were taken.
 */
export const runLoopPrChecks = async (
  host: LoopPrCheckHost,
  loop: Pick<ProjectLoopRecord, "councilBeforePr" | "verifyBeforePr">,
  run: RunRecord,
): Promise<{ changed: boolean }> => {
  const councilChanged = loop.councilBeforePr ? await runCouncilCheck(host, run) : false;
  const verificationChanged = loop.verifyBeforePr ? await runVerificationCheck(host, run) : false;
  return { changed: councilChanged || verificationChanged };
};

/** Verifies the final revision again when the UI review changed the code after verification passed. */
export const reverifyLoopIteration = async (
  host: LoopPrCheckHost,
  loop: Pick<ProjectLoopRecord, "verifyBeforePr">,
  run: RunRecord,
): Promise<void> => {
  if (loop.verifyBeforePr) await runVerificationCheck(host, run);
};
