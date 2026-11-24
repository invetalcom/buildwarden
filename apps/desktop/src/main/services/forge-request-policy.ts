import type {
  MergeRunForgeRequestInput,
  ProjectForgeRequestStatus,
  RunForgeCheck,
  RunForgeReadiness,
  RunForgeRequestSummary,
  UpdateRunForgeRequestInput,
} from "@buildwarden/shared";
import type { ForgeRequestStatusResult } from "../pr-review/pr-review-types";

const PROJECT_FORGE_TOKEN_SECRET_PREFIX = "project:forge-token:";
export const isOpenForgeRequestState = (state: string): boolean => state === "open" || state === "opened";

export const summarizeForgeChecks = (checks: RunForgeCheck[]): RunForgeRequestSummary["checks"] => {
  const completed = checks.filter((check) => check.status !== "queued" && check.status !== "running").length;
  const successful = checks.filter((check) => check.status === "success" || check.status === "neutral" || check.status === "skipped").length;
  const failed = checks.filter((check) => check.status === "failure" || check.status === "cancelled").length;
  return {
    completed,
    total: checks.length,
    successful,
    failed,
    running: checks.length - completed,
  };
};

export const forgeReadiness = (status: ForgeRequestStatusResult): RunForgeReadiness => {
  if (status.state === "merged") return "merged";
  if (status.state === "closed") return "closed";
  const checks = summarizeForgeChecks(status.checks);
  if (checks.failed > 0 || status.mergeability === "conflicting" || status.reviewDecision === "changes-requested") return "blocked";
  if (
    status.draft || checks.running > 0 || status.mergeability !== "mergeable" ||
    status.reviewDecision === "review-required" || status.unresolvedThreadCount > 0
  ) return "pending";
  return "ready";
};

export const toProjectForgeRequestStatus = (status: ForgeRequestStatusResult): ProjectForgeRequestStatus => ({
  state: status.state,
  readiness: forgeReadiness(status),
  draft: status.draft,
  mergeability: status.mergeability,
  reviewDecision: status.reviewDecision,
  headSha: status.headSha,
  checks: summarizeForgeChecks(status.checks),
  checkRuns: status.checks,
  unresolvedThreadCount: status.unresolvedThreadCount,
  supportedActions: status.supportedActions,
  supportedMergeMethods: status.supportedMergeMethods,
  lastSyncedAt: new Date().toISOString(),
});

export const assertForgeUpdateSupported = (
  supportedActions: RunForgeRequestSummary["supportedActions"],
  action: UpdateRunForgeRequestInput["action"],
): void => {
  if (!supportedActions.includes(action)) throw new Error("This action is not supported for the request.");
};

export const assertForgeMergeAllowed = (
  request: Pick<RunForgeRequestSummary, "state" | "draft" | "readiness" | "headSha" | "supportedMergeMethods">,
  input: MergeRunForgeRequestInput,
): void => {
  if (request.state !== "open" || request.draft || request.readiness !== "ready") {
    throw new Error("Only a green, open, ready request can be merged.");
  }
  if (!request.headSha || request.headSha.toLowerCase() !== input.expectedHeadSha.trim().toLowerCase()) {
    throw new Error("The request head changed. Refresh it before merging.");
  }
  if (!request.supportedMergeMethods.includes(input.method)) {
    throw new Error("That merge method is not supported by this repository.");
  }
};

export const projectForgeTokenSecretKey = (projectId: string) => `${PROJECT_FORGE_TOKEN_SECRET_PREFIX}${projectId}`;
