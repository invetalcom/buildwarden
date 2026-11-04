/** What a council round reviewed: workspace changes, or a text answer such as a proposal. */
export type CouncilReviewKind = "code" | "text";
export type CouncilTrigger = "manual" | "auto";

export type CouncilRoundStatus =
  /** Reviewers are working on their isolated workspace copies. */
  | "reviewing"
  /** The run's own model is grouping the findings and judging them. */
  | "assessing"
  /** Results are available. Nothing has been applied. */
  | "ready"
  /** A follow-up turn on the original run is applying selected findings. */
  | "applying"
  | "applied"
  | "apply-failed"
  /** Too few reviewers produced a usable report. */
  | "failed"
  | "cancelled";

export type CouncilSeverity = "high" | "medium" | "low";

/** Why a reviewer produced no usable report. Drives retry behavior and the reason shown to the user. */
export type CouncilFailureKind = "limit" | "auth" | "transient" | "timeout" | "output" | "interrupted" | "unknown";

export type CouncilReviewStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export interface CouncilReview {
  id: string;
  modelId: string;
  /** Captured when the round starts so results stay readable after the model is removed. */
  modelLabel: string;
  providerLabel: string;
  effort: string | null;
  status: CouncilReviewStatus;
  childRunId: string | null;
  attempts: number;
  /** A malformed report gets one correction request in the same session. */
  repairRequested: boolean;
  failureKind: CouncilFailureKind | null;
  failureMessage: string | null;
  findingCount: number;
  /** The reviewer's own report, kept for the "raw report" view. */
  output: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface CouncilFinding {
  id: string;
  reviewId: string;
  title: string;
  severity: CouncilSeverity;
  /** Workspace-relative path; null for text reviews. */
  file: string | null;
  line: number | null;
  /** Passage of the reviewed answer this finding refers to; null for code reviews. */
  quote: string | null;
  problem: string;
  /** Concrete situation in which this causes harm. */
  impact: string;
  suggestion: string | null;
}

export type CouncilGroupDecision = "recommended" | "rejected" | "unassessed";

/** One root cause. Every finding belongs to exactly one group, so duplicates collapse without being lost. */
export interface CouncilFindingGroup {
  id: string;
  title: string;
  severity: CouncilSeverity;
  decision: CouncilGroupDecision;
  reason: string | null;
  findingIds: string[];
}

export interface CouncilRound {
  id: string;
  runId: string;
  projectId: string;
  status: CouncilRoundStatus;
  kind: CouncilReviewKind;
  trigger: CouncilTrigger;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Reviewers that have not reported by this time are stopped. */
  deadlineAt: string;
  minReviews: number;
  autoApply: boolean;
  /** The run's model. It assesses the findings and applies accepted ones. */
  authorModelId: string;
  authorModelLabel: string;
  /** Identifies the reviewed content, so later changes can be detected. */
  subjectFingerprint: string;
  reviews: CouncilReview[];
  assessment: CouncilReview | null;
  assessmentError: string | null;
  summary: string | null;
  findings: CouncilFinding[];
  groups: CouncilFindingGroup[];
  appliedGroupIds: string[];
  error: string | null;
  /** Timeline step showing this round in the run activity. */
  stepId: string | null;
  /** Set when read: the reviewed content has changed since this round started. */
  stale?: boolean;
}

export const COUNCIL_ACTIVE_STATUSES: readonly CouncilRoundStatus[] = ["reviewing", "assessing", "applying"];
export const isCouncilRoundActive = (round: Pick<CouncilRound, "status">): boolean =>
  COUNCIL_ACTIVE_STATUSES.includes(round.status);

/** True while a round's selected findings can still be sent to the author. */
export const canApplyCouncilRound = (round: Pick<CouncilRound, "status" | "groups">): boolean =>
  (round.status === "ready" || round.status === "apply-failed") && round.groups.length > 0;

export const COUNCIL_REVIEW_EVENT_TITLE = "Council validation";

/** Runs a user can validate. Child runs and automated pipelines have their own review steps. */
export const isCouncilRunKind = (kind: string): boolean => kind === "standard" || kind === "automation";

/** A finding as it was handed to the run's model. Stored on the fix turn so it outlives the panel. */
export interface CouncilAppliedFinding {
  title: string;
  severity: CouncilSeverity;
  location: string | null;
  quote: string | null;
  problem: string;
  impact: string;
  suggestion: string | null;
  assessment: string | null;
  raisedBy: string[];
}

export interface CouncilApplyRecord {
  label: string;
  findings: CouncilAppliedFinding[];
}

/** Reads the record from step metadata, which comes from storage and may predate this shape. */
export const readCouncilApplyRecord = (metadata: Record<string, unknown>): CouncilApplyRecord | null => {
  const record = metadata.councilApply as Partial<CouncilApplyRecord> | null | undefined;
  return record && typeof record.label === "string" && Array.isArray(record.findings) && record.findings.length > 0
    ? record as CouncilApplyRecord
    : null;
};

export interface CouncilReviewerConfig {
  modelId: string;
  /** Reasoning effort override. Empty uses the model default. */
  effort?: string;
}

export interface CouncilSettings {
  version: 1;
  reviewers: CouncilReviewerConfig[];
  /** Usable reports needed before results are produced. */
  minReviews: number;
  timeoutMinutes: number;
  /** Start a validation when an eligible run completes. */
  autoRun: boolean;
  /** Apply recommended findings without asking. */
  autoApply: boolean;
}

export const COUNCIL_MAX_REVIEWERS = 8;
export const COUNCIL_MIN_TIMEOUT_MINUTES = 2;
export const COUNCIL_MAX_TIMEOUT_MINUTES = 120;

export const DEFAULT_COUNCIL_SETTINGS: CouncilSettings = {
  version: 1,
  reviewers: [],
  minReviews: 1,
  timeoutMinutes: 15,
  autoRun: false,
  autoApply: false,
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export const parseCouncilSettings = (raw: string | undefined): CouncilSettings => {
  const defaults = { ...DEFAULT_COUNCIL_SETTINGS, reviewers: [] };
  if (!raw?.trim()) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const seen = new Set<string>();
    const reviewers = (Array.isArray(parsed.reviewers) ? parsed.reviewers : []).flatMap((entry): CouncilReviewerConfig[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
      if (!modelId || seen.has(modelId)) return [];
      seen.add(modelId);
      const effort = typeof record.effort === "string" ? record.effort.trim() : "";
      return [{ modelId, ...(effort ? { effort } : {}) }];
    }).slice(0, COUNCIL_MAX_REVIEWERS);
    return {
      version: 1,
      reviewers,
      minReviews: clampInteger(parsed.minReviews, 1, 1, Math.max(1, reviewers.length)),
      timeoutMinutes: clampInteger(parsed.timeoutMinutes, DEFAULT_COUNCIL_SETTINGS.timeoutMinutes, COUNCIL_MIN_TIMEOUT_MINUTES, COUNCIL_MAX_TIMEOUT_MINUTES),
      autoRun: parsed.autoRun === true && reviewers.length > 0,
      autoApply: parsed.autoApply === true,
    };
  } catch {
    return defaults;
  }
};

/**
 * Reviewers that can actually run. The single source of truth for whether the feature is
 * available: saved reviewers whose model was disabled or removed do not count.
 */
export const resolveCouncilReviewers = (
  settings: Pick<CouncilSettings, "reviewers">,
  models: ReadonlyArray<{ id: string; enabled: boolean | number }>,
): CouncilReviewerConfig[] => {
  const enabled = new Set(models.filter((model) => Boolean(model.enabled)).map((model) => model.id));
  return settings.reviewers.filter((reviewer) => enabled.has(reviewer.modelId));
};

/** Removes one model from saved settings, keeping the minimum reachable. */
export const removeCouncilReviewerModel = (settings: CouncilSettings, modelId: string): CouncilSettings => {
  const reviewers = settings.reviewers.filter((reviewer) => reviewer.modelId !== modelId);
  return {
    ...settings,
    reviewers,
    minReviews: Math.min(settings.minReviews, Math.max(1, reviewers.length)),
    autoRun: settings.autoRun && reviewers.length > 0,
  };
};

const countLabel = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** One line describing a round, used by the run activity card and stored on its timeline step. */
export const councilRoundSummary = (round: Pick<CouncilRound, "status" | "reviews" | "findings" | "groups" | "kind" | "authorModelLabel" | "appliedGroupIds">): string => {
  const total = round.reviews.length;
  const usable = round.reviews.filter((review) => review.status === "completed").length;
  const settled = round.reviews.filter((review) => review.status !== "queued" && review.status !== "running").length;
  const coverage = usable === total ? countLabel(total, "model") : `${String(usable)} of ${countLabel(total, "model")}`;
  const applied = countLabel(round.appliedGroupIds.length, "finding");
  switch (round.status) {
    case "reviewing":
      return `Validating · ${String(settled)} of ${countLabel(total, "review")} finished`;
    case "assessing":
      return `${round.authorModelLabel} is assessing ${countLabel(round.findings.length, "finding")}`;
    case "ready": {
      if (!round.groups.length) return `No findings from ${coverage}`;
      const recommended = round.groups.filter((group) => group.decision === "recommended").length;
      const rejected = round.groups.filter((group) => group.decision === "rejected").length;
      return [
        countLabel(round.groups.length, "finding"),
        recommended ? `${String(recommended)} recommended` : null,
        rejected ? `${String(rejected)} rejected` : null,
        `from ${coverage}`,
      ].filter(Boolean).join(" · ");
    }
    case "applying":
      return round.kind === "code" ? `Fixing ${applied}` : `Revising the answer with ${applied}`;
    case "applied":
      return round.kind === "code" ? `Fixed ${applied}` : `Revised the answer with ${applied}`;
    case "apply-failed":
      return `Could not apply ${applied}`;
    case "failed":
      return `Validation could not finish · ${String(usable)} of ${countLabel(total, "review")} usable`;
    case "cancelled":
      return "Validation cancelled";
  }
};

export const COUNCIL_FAILURE_LABELS: Record<CouncilFailureKind, string> = {
  limit: "Usage limit",
  auth: "Sign-in problem",
  transient: "Connection problem",
  timeout: "Timed out",
  output: "Unreadable report",
  interrupted: "Interrupted",
  unknown: "Failed",
};

/** Short state for places with room for only a few words. */
export const councilActiveLabel = (round: Pick<CouncilRound, "status" | "kind" | "reviews">): string => {
  if (round.status === "assessing") return "Assessing findings";
  if (round.status === "applying") return round.kind === "code" ? "Fixing" : "Revising";
  const settled = round.reviews.filter((review) => review.status !== "queued" && review.status !== "running").length;
  return `Validating ${String(settled)}/${String(round.reviews.length)}`;
};

/** A finished round stays the answer until the work changes, so a click never pays for the same review twice. */
export const councilHasCurrentResults = (round: Pick<CouncilRound, "status" | "stale">): boolean =>
  round.status === "ready" && !round.stale;

/** Some reviewers produced nothing, so "no findings" here does not mean a clean pass. */
export const councilIsPartial = (round: Pick<CouncilRound, "status" | "reviews">): boolean =>
  !isCouncilRoundActive(round) && round.status !== "cancelled" && round.reviews.some((review) => review.status !== "completed");

/** Offer a repeat only when it would add information. */
export const councilWorthRepeating = (round: Pick<CouncilRound, "status" | "stale" | "reviews">): boolean =>
  round.status !== "ready" || round.stale === true || councilIsPartial(round);

export const councilFindingLocation = (finding: Pick<CouncilFinding, "file" | "line">): string | null =>
  finding.file ? `${finding.file}${finding.line ? `:${String(finding.line)}` : ""}` : null;

/** The file name is enough on a row; the full path is one tap away. */
export const councilShortLocation = (location: string): string => location.split(/[\\/]/).at(-1) ?? location;

export const councilGroupFindings = (round: Pick<CouncilRound, "findings">, group: Pick<CouncilFindingGroup, "findingIds">): CouncilFinding[] =>
  round.findings.filter((finding) => group.findingIds.includes(finding.id));

/** Everything the assessment did not reject starts selected. */
export const councilDefaultSelection = (round: Pick<CouncilRound, "groups">): string[] =>
  round.groups.filter((group) => group.decision !== "rejected").map((group) => group.id);

export const councilApplyActionLabel = (kind: CouncilReviewKind, count: number): string => {
  const noun = count === 1 ? "finding" : "findings";
  return kind === "code" ? `Fix ${String(count)} ${noun}` : `Revise answer with ${String(count)} ${noun}`;
};

const SEVERITY_ORDER: Record<CouncilSeverity, number> = { high: 0, medium: 1, low: 2 };
export const compareCouncilSeverity = (left: CouncilSeverity, right: CouncilSeverity): number =>
  SEVERITY_ORDER[left] - SEVERITY_ORDER[right];

export const councilGroupsByDecision = (groups: readonly CouncilFindingGroup[], decision: CouncilGroupDecision): CouncilFindingGroup[] =>
  groups.filter((group) => group.decision === decision).sort((left, right) => compareCouncilSeverity(left.severity, right.severity));

/** Distinct models behind a group. One model repeating itself is not agreement. */
export const councilGroupReviewers = (round: Pick<CouncilRound, "findings" | "reviews">, group: Pick<CouncilFindingGroup, "findingIds">): CouncilReview[] => {
  const reviewIds = new Set(round.findings.filter((finding) => group.findingIds.includes(finding.id)).map((finding) => finding.reviewId));
  const byModel = new Map<string, CouncilReview>();
  for (const review of round.reviews) {
    if (reviewIds.has(review.id) && !byModel.has(review.modelId)) byModel.set(review.modelId, review);
  }
  return [...byModel.values()];
};
